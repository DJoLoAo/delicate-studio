importScripts("/edit.js", "/trcore.js", "/tags.js", "/onset.js", "/sesmath.js");

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

function useLists(c, lists) {
  c.marks = c.hist[c.idx].marks;
  c.lists = lists;
  c.cum = lists.map(cumOf);
  c.len = clipLen(lists[0]);
}

function setLists(lists) { useLists(cur, lists); }

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
    case "pencil": {
      const k = clampI(m.pc, 0, ch - 1), pa = clampI(m.pa, 0, F - 1);
      const src = m.data instanceof Float32Array ? m.data : new Float32Array(Array.isArray(m.data) ? m.data : []);
      const n = Math.min(src.length, F - pa, sr * 60);
      if (n < 1) throw new Error("nothing");
      const d = new Float32Array(n);
      for (let i = 0; i < n; i++) { const v = src[i]; d[i] = Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0; }
      const w = allocBegin();
      allocPush(w, d, n);
      const id = allocEnd(w);
      const spans = new Array(ch).fill(null);
      spans[k] = [[pa, pa + n, [[id, 0, 0, n]]]];
      lists = opPatch(c.lists, spans);
      info = { op: "pencil", a: pa, b: pa + n, n, ch: ch > 1 ? chanLabel(chans.map((_, i) => i === k)) : null };
      after = { a: before.a, b: before.b, cursor: before.cursor };
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
  if (PX.job) PX.job.cancel = true;
  if (TN.job) TN.job.cancel = true;
  TN.feat = null;
  MDL.mode = "off";
  MDL.notes = [];
  if (c.saving) { try { await c.saving; } catch {} }
  if (clip && !clip.file && clip.doc === c.meta.id) { try { await materializeClip(); } catch { clip = null; } }
  if (c.busy > 0) lingering.set(c.meta.id, c); else closeHandles(c);
  cur = null;
}

function sinkNew(pool, ch, sr) {
  return { pool, ch, block: new Float32Array(BLOCK * ch), fill: 0, slot: 0, total: 0, peaks: [], bands: [], lp: biquad("lp", 200, sr), hp: biquad("hp", 2500, sr), bl: 0, bm: 0, bh: 0, bn: 0, band: new Float32Array(BPB * 3), bandK: 0 };
}

function sinkBand(S) {
  const k = S.bandK % BPB;
  S.band[k * 3] = Math.sqrt(S.bl / S.bn);
  S.band[k * 3 + 1] = Math.sqrt(S.bm / S.bn);
  S.band[k * 3 + 2] = Math.sqrt(S.bh / S.bn);
  S.bl = S.bm = S.bh = 0;
  S.bn = 0;
  S.bandK++;
  if (S.bandK % BPB === 0) { S.bands.push(S.band); S.band = new Float32Array(BPB * 3); }
}

function sinkSlot(S) {
  const ch = S.ch, block = S.block, fill = S.fill;
  putAt(S.pool, new Uint8Array(block.buffer), S.slot * BLOCK * ch * 4);
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
  S.peaks.push(pk);
  S.slot++;
  S.fill = 0;
  block.fill(0);
}

function sinkPush(S, src, n) {
  const ch = S.ch, lp = S.lp, hp = S.hp;
  const lb0 = lp.b0, lb1 = lp.b1, lb2 = lp.b2, la1 = lp.a1, la2 = lp.a2;
  const hb0 = hp.b0, hb1 = hp.b1, hb2 = hp.b2, ha1 = hp.a1, ha2 = hp.a2;
  let lx1 = lp.x1, lx2 = lp.x2, ly1 = lp.y1, ly2 = lp.y2, hx1 = hp.x1, hx2 = hp.x2, hy1 = hp.y1, hy2 = hp.y2;
  let bl = S.bl, bm = S.bm, bh = S.bh, bn = S.bn;
  const inv = 1 / ch;
  for (let i = 0; i < n; i++) {
    let m = src[i];
    for (let c = 1; c < ch; c++) m += src[c * n + i];
    m *= inv;
    const l = lb0 * m + lb1 * lx1 + lb2 * lx2 - la1 * ly1 - la2 * ly2;
    lx2 = lx1; lx1 = m; ly2 = ly1; ly1 = l;
    const h = hb0 * m + hb1 * hx1 + hb2 * hx2 - ha1 * hy1 - ha2 * hy2;
    hx2 = hx1; hx1 = m; hy2 = hy1; hy1 = h;
    const md = m - l - h;
    bl += l * l; bm += md * md; bh += h * h;
    if (++bn === BUCKET) { S.bl = bl; S.bm = bm; S.bh = bh; S.bn = bn; sinkBand(S); bl = bm = bh = 0; bn = 0; }
  }
  lp.x1 = lx1; lp.x2 = lx2; lp.y1 = ly1; lp.y2 = ly2; hp.x1 = hx1; hp.x2 = hx2; hp.y1 = hy1; hp.y2 = hy2;
  S.bl = bl; S.bm = bm; S.bh = bh; S.bn = bn;
  let done = 0;
  while (done < n) {
    const run = Math.min(n - done, BLOCK - S.fill);
    for (let c = 0; c < ch; c++) S.block.set(src.subarray(c * n + done, c * n + done + run), c * BLOCK + S.fill);
    S.fill += run;
    done += run;
    if (S.fill === BLOCK) sinkSlot(S);
  }
  S.total += n;
}

function sinkEnd(S) {
  if (S.bn > 0) sinkBand(S);
  if (S.fill > 0) sinkSlot(S);
  if (S.bandK % BPB !== 0) S.bands.push(S.band);
  const ch = S.ch, slots = S.slot;
  const slotPeaks = new Float32Array(slots * ch * BPB * 2);
  S.peaks.forEach((p, i) => slotPeaks.set(p, i * ch * BPB * 2));
  const bands = new Float32Array(slots * BPB * 3);
  S.bands.forEach((b, i) => { if (i < slots) bands.set(b, i * BPB * 3); });
  return { slots, slotPeaks, bands };
}

function tgSniff(d) {
  if (d.length > 3 && d[0] === 0xFF && d[1] === 0xD8) return "image/jpeg";
  if (d.length > 8 && d[0] === 0x89 && d[1] === 0x50 && d[2] === 0x4E && d[3] === 0x47) return "image/png";
  return "";
}

function tgDecMeta(x, mem) {
  try {
    if (typeof x.dec_meta_len !== "function") return null;
    const n = x.dec_meta_len();
    const j = n ? JSON.parse(new TextDecoder().decode(new Uint8Array(mem.buffer, x.dec_meta_ptr(), n))) : {};
    const cl = x.dec_cover_len();
    if (cl && cl <= 4 << 20) {
      const data = new Uint8Array(mem.buffer, x.dec_cover_ptr(), cl).slice(), mime = tgSniff(data);
      if (mime) j.pic = { mime, w: (j.cover && j.cover.w) | 0, h: (j.cover && j.cover.h) | 0, data };
    }
    return j;
  } catch { return null; }
}

function tgFileInfo(fm, scan, source, sr, F) {
  let tags = tgClean((fm && Array.isArray(fm.tags) ? fm.tags : []).concat(scan && scan.tags ? scan.tags : []), true);
  const cueText = tgGet(tags, "CUESHEET");
  tags = tgClean(tags);
  if (!tags.length && source) tags = tgClean([["TITLE", source.title], ["ARTIST", source.artist], ["ALBUM", source.album]]);
  let list = [];
  if (scan && scan.kind === "wav" && scan.marks.length) list = scan.marks.map(m => ({ a: m.a, b: m.b, name: m.name }));
  else if (cueText) list = tgCueRanges(tgCue(cueText), sr, F).map(r => Object.assign(r, { tag: trTagClean(r.tag) }));
  if (!list.length && scan && scan.kind === "flac") {
    const cs = scan.cues.filter(c => !c.lead).sort((p, q) => p.a - q.a);
    if (cs.length > 1) list = cs.map((c, i) => ({ a: c.a, b: i + 1 < cs.length ? cs[i + 1].a : F, name: String(c.n).padStart(2, "0") }));
  }
  list = list.filter(m => Number.isFinite(m.a) && m.a >= 0 && m.a <= F).map(m => Object.assign({}, m, { b: m.b > m.a ? Math.min(F, m.b) : 0 })).filter(m => !(m.b && m.b <= m.a));
  return { tags, locs: tgMarks(list), cover: fm && fm.pic ? fm.pic : null };
}

async function tagsGet(m) {
  const c = cur && cur.meta.id === m.id ? cur : lingering.get(m.id) || null;
  const dir = c ? c.dir : await (await docsDir()).getDirectoryHandle(String(m.id));
  const meta = c ? c.meta : await readJson(dir, "meta.json");
  let cover = null;
  if (meta.cover) {
    try {
      const f = await (await dir.getFileHandle("cover.bin")).getFile();
      cover = Object.assign({}, meta.cover, { data: await f.arrayBuffer() });
    } catch {}
  }
  return { t: "tags", tags: meta.tags || [], cover };
}

async function tagsSet(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  c.meta.tags = tgClean(m.tags);
  if (m.cover === null) {
    try { await c.dir.removeEntry("cover.bin"); } catch {}
    delete c.meta.cover;
  } else if (m.cover && m.cover.data) {
    const data = new Uint8Array(m.cover.data), mime = tgSniff(data);
    if (!mime || data.length > 4 << 20) throw new Error("cover");
    await writeFile(c.dir, "cover.bin", data);
    c.meta.cover = { mime, w: Math.max(0, m.cover.w | 0), h: Math.max(0, m.cover.h | 0), size: data.length };
  }
  await writeFile(c.dir, "meta.json", enc(c.meta));
  return { t: "tagsaved", tags: c.meta.tags, cover: c.meta.cover || null };
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
    const fm = tgDecMeta(x, mem);
    const S = sinkNew(pool, ch, sr);
    let lastPost = 0, lastYield = performance.now();
    for (;;) {
      const n = x.dec_next();
      if (n < 0) throw new Error(err());
      if (n === 0) break;
      sinkPush(S, new Float32Array(mem.buffer, x.dec_buf(), n * ch), n);
      const total = S.total, now = performance.now();
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
    const total = S.total;
    if (total === 0) throw new Error("no audio in file");
    const { slots, slotPeaks, bands } = sinkEnd(S);
    pool.flush();
    pool.close();
    pool = null;
    await writeFile(docDir, "peaks.f32", slotPeaks);
    await writeFile(docDir, "bands.f32", bands);
    const source = opts.source || { kind: "local", lastModified: file.lastModified || 0 };
    const meta = { v: 1, id, name: displayName, ext, size: file.size, sampleRate: sr, channels: ch, bits, frames: total, blockFrames: BLOCK, slots, created: Date.now(), opened: Date.now(), readOnly: source.kind === "library" || source.kind === "locker", source };
    const rd = (pos, n) => pos >= file.size || n <= 0 ? new Uint8Array(0) : new Uint8Array(reader.readAsArrayBuffer(file.slice(pos, Math.min(file.size, pos + n))));
    const fi = tgFileInfo(fm, tgRiff(rd, file.size) || tgFlac(rd, file.size), source, sr, total);
    meta.tags = fi.tags;
    if (fi.locs.length) meta.locs = fi.locs;
    if (fi.cover) { await writeFile(docDir, "cover.bin", fi.cover.data); meta.cover = { mime: fi.cover.mime, w: fi.cover.w, h: fi.cover.h, size: fi.cover.data.length }; }
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
    if (!cur.io) cur.io = makeIo();
    cur.meta.opened = Date.now();
    return { meta: cur.meta, peaks: timelinePeaks(slotPeaks, cur.meta.channels, cur.meta.slots), bands, state: statePayload(have || 1), recovered: false };
  }
  cur = await loadDoc(docDir, meta);
  cur.io = makeIo();
  meta.opened = Date.now();
  meta.len = cur.len;
  try { await writeFile(docDir, "meta.json", enc(meta)); } catch {}
  return { meta, peaks: timelinePeaks(slotPeaks, meta.channels, meta.slots), bands, state: statePayload(have || 1), recovered: !!cur.recovered };
}

function firstHist(meta) {
  const rm = Array.isArray(meta.marks) ? meta.marks.filter(a => Number.isFinite(a) && a >= 0 && a <= meta.frames).slice(0, 999) : [];
  const locs = Array.isArray(meta.locs) && validMarks(meta.locs, meta.frames) ? meta.locs : null;
  return [{ op: "open", a: 0, b: 0, n: 0, ch: null, t: meta.created || Date.now(), lists: origLists(meta), marks: locs || rm.map((a, i) => ({ id: i + 1, n: i + 1, kind: "point", a: Math.round(a), name: "", view: null, chans: null })), d: null, full: false, before: null, after: null }];
}

async function loadDoc(docDir, meta) {
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
  const c = { meta, pool, heap, hpk, dir: docDir, heapEnd: heapFrames, pkEnd: pkFloats, allocs: [null], sums: [null], hist: null, idx: 0, seq: 0, lists: null, cum: null, len: 0, edges: new Map(), ver: 0, saving: null, dirty: false, saveErr: null, busy: 0, recovered: !!st.recovered };
  if (st.hist) {
    c.allocs = st.allocs;
    c.hist = st.hist;
    c.idx = st.idx;
    c.seq = st.seq;
    const all = new Float32Array(pkFloats);
    if (pkFloats) hpk.read(new Uint8Array(all.buffer), { at: 0 });
    for (let i = 1; i < st.allocs.length; i++) {
      const a = st.allocs[i], n0 = Math.ceil(a[1] / BUCKET);
      c.sums[i] = { pk: all.slice(a[2], a[2] + n0 * 2), bd: all.slice(a[2] + n0 * 2, a[2] + n0 * 5) };
    }
  } else c.hist = firstHist(meta);
  useLists(c, c.hist[c.idx].lists);
  return c;
}

function docInfoOf(c) {
  const m = c.meta;
  return { id: m.id, name: m.name, sampleRate: m.sampleRate, channels: m.channels, bits: m.bits, frames: c.len, tags: m.tags || [], cover: m.cover || null, source: m.source || null, marks: c.marks, edits: c.idx };
}

async function peekDoc(id) {
  if (cur && cur.meta.id === id) return docInfoOf(cur);
  if (lingering.has(id)) return docInfoOf(lingering.get(id));
  const docDir = await (await docsDir()).getDirectoryHandle(id);
  const meta = await readJson(docDir, "meta.json");
  if (meta.recording) throw new Error("recording");
  const size = async n => { try { return (await (await docDir.getFileHandle(n)).getFile()).size; } catch { return 0; } };
  const st = await loadEdits(docDir, meta, Math.floor(await size("heap.f32") / 4), Math.floor(await size("heap.pk") / 4));
  const hist = st.hist || firstHist(meta), idx = st.hist ? st.idx : 0;
  return docInfoOf({ meta, len: clipLen(hist[idx].lists[0]), marks: hist[idx].marks, idx });
}

async function docInfo(m) {
  const docs = [];
  for (const id of Array.isArray(m.ids) ? m.ids.slice(0, 64) : []) {
    try { docs.push(await peekDoc(String(id))); } catch (e) { docs.push({ id: String(id), error: errText(e) }); }
  }
  return { t: "docinfo", docs };
}

function albumClean(v) {
  const s = (x, n) => String(x == null ? "" : x).slice(0, n);
  const out = [];
  for (const a of Array.isArray(v) ? v.slice(0, 500) : []) {
    if (!a || typeof a !== "object") continue;
    const sides = [];
    for (const d of Array.isArray(a.sides) ? a.sides : []) { const id = s(d, 80); if (id && !sides.includes(id) && sides.length < 26) sides.push(id); }
    let rel = a.release && typeof a.release === "object" ? a.release : null;
    if (rel && JSON.stringify(rel).length > 200000) rel = null;
    out.push({ id: s(a.id, 60) || crypto.randomUUID(), title: s(a.title, 200), release: rel, sides, created: Number(a.created) || Date.now(), updated: Date.now() });
  }
  return out;
}

async function albumsGet() {
  try {
    const j = await readJson(await studioDir(), "albums.json");
    return { t: "albums", albums: Array.isArray(j.albums) ? j.albums : [] };
  } catch { return { t: "albums", albums: [] }; }
}

async function albumsPut(m) {
  const albums = albumClean(m.albums);
  await writeFile(await studioDir(), "albums.json", enc({ v: 1, albums }));
  return { t: "albums", albums };
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
  if (!play || !ring || (!play.mix && !cur)) return;
  const ctrl = ring.ctrl, R = ring.size, ch = play.mix ? 2 : cur.meta.channels;
  const len = play.end - play.start;
  for (let guard = 0; guard < 64; guard++) {
    const w = Atomics.load(ctrl, 1), r = Atomics.load(ctrl, 2);
    const lim = !play.mix && FX.mode !== "off" ? Math.min(R, Math.max(4 * CHUNK, Math.round(cur.meta.sampleRate * 0.5))) : play.mix && SES.anyFx && SES.s ? Math.min(R, Math.max(4 * CHUNK, Math.round(SES.s.sr * 0.25))) : R;
    const free = lim - (w - r);
    if (free < CHUNK) return;
    if (!play.loop && w >= len) return;
    let n = Math.min(CHUNK, free);
    if (!play.loop) n = Math.min(n, len - w);
    let done = 0;
    while (done < n) {
      const p = srcPos(w + done);
      const run = play.loop ? Math.min(n - done, play.end - p) : n - done;
      if (play.mix) { if (SES.mix) SES.mix(p, run, play.tmp, CHUNK); else play.tmp.fill(0); }
      else {
        readClip(p, run, play.tmp, CHUNK);
        if (FX.mode !== "off") fxView(p, run, play.tmp, CHUNK);
        else if (RP.listen !== "off") rpOverlay(p, run, play.tmp, CHUNK);
        if (MDL.mode !== "off") mdSynth(p, run, play.tmp, CHUNK);
      }
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

const SES = { s: null, docs: new Map(), mix: null, job: null, punch: null, scn: null };

async function sessionsDir() {
  return (await studioDir()).getDirectoryHandle("sessions", { create: true });
}

function sesClean(v) {
  const str = (x, n) => String(x == null ? "" : x).slice(0, n);
  const int = (x, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(x) || 0)));
  const num = (x, lo, hi, d) => { const n = Number(x); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const s = v && typeof v === "object" ? v : {};
  const sr = int(s.sr, 0, 768000);
  const tracks = [];
  for (const tr of Array.isArray(s.tracks) ? s.tracks.slice(0, 64) : []) {
    if (!tr || typeof tr !== "object") continue;
    const clips = [];
    for (const k of Array.isArray(tr.clips) ? tr.clips.slice(0, 2000) : []) {
      if (!k || typeof k !== "object" || !k.doc) continue;
      const len = int(k.len, 1, 2 ** 40), fin = int(k.fin, 0, len);
      clips.push({ id: str(k.id, 40) || crypto.randomUUID().slice(0, 12), doc: str(k.doc, 80), at: int(k.at, 0, 2 ** 40), from: int(k.from, 0, 2 ** 40), len, gain: num(k.gain, -96, 24, 0), fin, fout: int(k.fout, 0, len - fin), name: str(k.name, 160) });
    }
    clips.sort((a, b) => a.at - b.at);
    const env = (L, lo, hi) => {
      const out = [];
      for (const q of Array.isArray(L) ? L.slice(0, 20000) : []) if (Array.isArray(q) && q.length >= 2 && Number.isFinite(Number(q[0])) && Number.isFinite(Number(q[1]))) out.push([int(q[0], 0, 2 ** 40), num(q[1], lo, hi, 0)]);
      out.sort((a, b) => a[0] - b[0]);
      return out.filter((q, i) => i === 0 || q[0] !== out[i - 1][0]);
    };
    const au = tr.auto && typeof tr.auto === "object" ? tr.auto : {};
    const auto = { vol: env(au.vol, SM_FLOOR, SM_TOP), pan: env(au.pan, -1, 1) };
    const touch = tr.touch === "vol" || tr.touch === "pan" ? tr.touch : "";
    const takes = [];
    for (const q of Array.isArray(tr.takes) ? tr.takes.slice(0, 500) : []) if (q && typeof q === "object" && q.doc) takes.push({ id: str(q.id, 40) || crypto.randomUUID().slice(0, 12), doc: str(q.doc, 80), at: int(q.at, -(2 ** 40), 2 ** 40), from: int(q.from, 0, 2 ** 40), len: int(q.len, 1, 2 ** 40), n: int(q.n, 1, 9999), name: str(q.name, 160) });
    tracks.push({ id: str(tr.id, 40) || crypto.randomUUID().slice(0, 12), name: str(tr.name, 80), gain: num(tr.gain, -96, 12, 0), pan: num(tr.pan, -1, 1, 0), mute: !!tr.mute, solo: !!tr.solo, clips, auto, touch, view: ["vol", "pan"].includes(tr.view) ? tr.view : "", fx: rkObj(tr.fx), takes, lanes: !!tr.lanes && takes.length > 0 });
  }
  const marks = [];
  for (const k of Array.isArray(s.marks) ? s.marks.slice(0, 999) : []) if (k && typeof k === "object") marks.push({ id: str(k.id, 40) || crypto.randomUUID().slice(0, 12), at: int(k.at, 0, 2 ** 40), name: str(k.name, 160) });
  marks.sort((a, b) => a.at - b.at);
  const src = s.src && typeof s.src === "object" ? { kind: str(s.src.kind, 20), rec: str(s.src.rec, 80) } : null;
  const sc = s.scenes && typeof s.scenes === "object" ? s.scenes : {}, tids = new Set(tracks.map(tr => tr.id)), rows = [];
  for (const row of Array.isArray(sc.rows) ? sc.rows.slice(0, 64) : []) {
    if (!row || typeof row !== "object") continue;
    const slots = {};
    for (const [tid, k] of Object.entries(row.slots && typeof row.slots === "object" ? row.slots : {})) {
      if (!tids.has(tid) || !k || typeof k !== "object" || !k.doc) continue;
      slots[tid] = { id: str(k.id, 40) || crypto.randomUUID().slice(0, 12), doc: str(k.doc, 80), from: int(k.from, 0, 2 ** 40), len: int(k.len, 1, 2 ** 40), name: str(k.name, 160), loop: k.loop !== false, gain: num(k.gain, -96, 24, 0), lufs: num(k.lufs, -120, 20, null) };
    }
    rows.push({ id: str(row.id, 40) || crypto.randomUUID().slice(0, 12), name: str(row.name, 80), slots });
  }
  const scenes = { tempo: num(sc.tempo, 20, 300, 120), quant: ["bar", "beat", "off"].includes(sc.quant) ? sc.quant : "bar", rows, ab: !!sc.ab };
  return { v: 1, id: str(s.id, 60) || crypto.randomUUID(), name: str(s.name, 160) || "Session", sr: sr >= 8000 ? sr : 0, created: Number(s.created) || Date.now(), modified: Date.now(), tracks, marks, src, master: { fx: rkObj(s.master && s.master.fx) }, scenes };
}

function sesLen(s) {
  let n = 0;
  for (const tr of s.tracks) for (const k of tr.clips) n = Math.max(n, k.at + k.len);
  return n;
}

async function sesRead(id) {
  return sesClean(await readJson(await sessionsDir(), String(id).replace(/[^\w-]/g, "") + ".json"));
}

async function sesWrite(s) {
  await writeFile(await sessionsDir(), s.id.replace(/[^\w-]/g, "") + ".json", enc(s));
}

async function sesList() {
  const dir = await sessionsDir(), out = [];
  for await (const [name, h] of dir.entries()) {
    if (h.kind !== "file" || !name.endsWith(".json")) continue;
    try {
      const s = sesClean(JSON.parse(await (await h.getFile()).text()));
      out.push({ id: s.id, name: s.name, sr: s.sr, tracks: s.tracks.length, len: sesLen(s), modified: s.modified });
    } catch {}
  }
  out.sort((a, b) => (b.modified || 0) - (a.modified || 0));
  return { t: "seslist", sessions: out };
}

async function sesUse(id) {
  if (SES.docs.has(id)) return SES.docs.get(id);
  let c = cur && cur.meta.id === id ? cur : lingering.get(id) || null;
  if (!c) {
    const docDir = await (await docsDir()).getDirectoryHandle(String(id));
    const meta = await readJson(docDir, "meta.json");
    if (meta.recording) throw new Error("recording");
    c = await loadDoc(docDir, meta);
    lingering.set(c.meta.id, c);
  }
  c.busy = (c.busy || 0) + 1;
  SES.docs.set(id, c);
  return c;
}

function sesRelease() {
  for (const c of SES.docs.values()) releaseDoc(c);
  SES.docs.clear();
  sesRackClear(null);
  SES.anyFx = false;
}

function sesEdge(c, seg) {
  if (seg[0] === SIL) return null;
  const st = seg[2], end = st + seg[3];
  const h1 = Math.min(end, Math.ceil(st / BUCKET) * BUCKET), t0 = Math.max(h1, Math.floor(end / BUCKET) * BUCKET);
  const e = [Infinity, -Infinity, Infinity, -Infinity], buf = new Float32Array(BUCKET);
  const mm = (f, n, k) => {
    readSrcOf(c, seg[0], seg[1], f, n, buf, 0);
    for (let i = 0; i < n; i++) { const v = buf[i]; if (v < e[k]) e[k] = v; if (v > e[k + 1]) e[k + 1] = v; }
  };
  if (h1 > st) mm(st, h1 - st, 0);
  if (end > t0) mm(t0, end - t0, 2);
  return e;
}

async function sesPayload(id) {
  let c;
  try { c = await sesUse(id); } catch { return { id, missing: true }; }
  const slotPeaks = await readFloat(c.dir, "peaks.f32"), bands = await readFloat(c.dir, "bands.f32");
  const allocs = [];
  for (let i = 1; i < c.allocs.length; i++) { const s = c.sums[i]; allocs.push({ id: i, n: c.allocs[i][1], pk: s.pk, bd: s.bd }); }
  return { id, meta: c.meta, len: c.len, peaks: timelinePeaks(slotPeaks, c.meta.channels, c.meta.slots), bands, lists: c.lists, edges: c.lists.map(l => l.map(g => sesEdge(c, g))), allocs, marks: (c.marks || []).filter(m => m && m.kind !== "view").map(m => ({ n: m.n, name: m.name || "", kind: m.kind, a: m.a, b: m.b || m.a })) };
}

async function sesOpen(m) {
  const s = await sesRead(m.id);
  sesRelease();
  SES.s = s;
  const ids = [...new Set(s.tracks.flatMap(tr => tr.clips.map(k => k.doc).concat(tr.takes.map(k => k.doc))).concat(s.scenes.rows.flatMap(r => Object.values(r.slots).map(k => k.doc))))];
  const docs = [];
  for (const id of ids) docs.push(await sesPayload(id));
  await dspExports();
  SES.mix = sesMixer(s);
  return { t: "sesopen", s, docs };
}

function rkObj(v) {
  if (!v || typeof v !== "object" || !v.cfg || typeof v.cfg !== "object") return null;
  const o = v.cfg, num = (x, lo, hi, d) => { const n = Number(x); return Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : d; };
  const ord = x => [2, 4, 8].includes(Number(x)) ? Number(x) : 4;
  const hp = o.hp || {}, lp = o.lp || {}, cp = o.comp || {}, lm = o.lim || {};
  return { on: v.on !== false, cfg: {
    hp: { on: !!hp.on, f: num(hp.f, 10, 2000, 30), ord: ord(hp.ord) }, lp: { on: !!lp.on, f: num(lp.f, 1000, 24000, 18000), ord: ord(lp.ord) },
    bands: (Array.isArray(o.bands) ? o.bands : []).slice(0, RK_BANDS).map(b => ({ on: !!b && b.on !== false, type: RK_TYPES.includes(b && b.type) ? b.type : "bell", f: num(b && b.f, 20, 22000, 1000), g: num(b && b.g, -30, 30, 0), q: num(b && b.q, 0.1, 40, 0.7071068) })),
    comp: { on: !!cp.on, thr: num(cp.thr, -80, 0, -18), ratio: num(cp.ratio, 1, 100, 3), knee: num(cp.knee, 0, 40, 6), att: num(cp.att, 0.1, 500, 5), rel: num(cp.rel, 5, 5000, 150), makeup: num(cp.makeup, -24, 40, 0) },
    lim: { on: !!lm.on, ceil: num(lm.ceil, -12, 0, -1), look: num(lm.look, 0.5, 20, 2), rel: num(lm.rel, 1, 2000, 100) }, out: num(o.out, -24, 24, 0), ...rkSp(o) } };
}

const SES_RK = { racks: new Map(), next: 8, free: [] };

function sesRack(key, fx, sr) {
  const x = XP.dsp;
  let R = SES_RK.racks.get(key);
  if (!fx || !fx.on || !x || !sr) {
    if (R) { x && x.rk_close(R.slot); SES_RK.free.push(R.slot); SES_RK.racks.delete(key); }
    return null;
  }
  const ck = JSON.stringify(fx.cfg);
  if (R && R.sr !== sr) { x.rk_close(R.slot); SES_RK.free.push(R.slot); SES_RK.racks.delete(key); R = null; }
  if (!R) {
    const slot = SES_RK.free.length ? SES_RK.free.pop() : SES_RK.next++;
    if (x.rk_open(slot, 2, sr) !== 0) throw new Error(dspError(x));
    R = { key, slot, sr, ck: "", lat: 0, warm: 0, x, q: [new Float32Array(1 << 16), new Float32Array(1 << 16)], qOff: 0, qLen: 0, qStart: -1, inPos: 0, drop: 0, inb: new Float32Array(NR_FEED * 2) };
    SES_RK.racks.set(key, R);
  }
  if (R.ck !== ck) {
    const lat = rkTune(x, R.slot, fx.cfg, false);
    if (lat !== R.lat) R.qStart = -1;
    R.lat = lat;
    R.warm = rkWarm(x, R.slot, lat, sr);
    R.ck = ck;
  }
  return R;
}

function sesRackClear(keep) {
  for (const [k, R] of [...SES_RK.racks]) if (!keep || !keep.has(k)) { if (R.x) R.x.rk_close(R.slot); SES_RK.free.push(R.slot); SES_RK.racks.delete(k); }
}

function sesRackRun(R, src, p, n, out, stride) {
  const x = R.x, m = NR_FEED;
  if (R.qStart !== p || p < 0) {
    x.rk_reset(R.slot);
    const o = p - R.warm;
    R.inPos = o;
    R.qStart = p;
    R.qOff = 0;
    R.qLen = 0;
    R.drop = R.warm;
  }
  while (R.qLen < n) {
    src(R.inPos, m, R.inb, m);
    wasmF32(x, x.rk_in(R.slot, m), m * 2).set(R.inb);
    R.inPos += m;
    const made = x.rk_run(R.slot, m);
    if (made < 0) throw new Error(dspError(x));
    const o = wasmF32(x, x.rk_out(R.slot), made * 2), from = Math.min(made, R.drop);
    R.drop -= from;
    const add = made - from;
    if (!add) continue;
    if (R.qOff + R.qLen + add > R.q[0].length) {
      if (R.qLen + add > R.q[0].length) for (let k = 0; k < 2; k++) { const big = new Float32Array(Math.max(R.q[k].length * 2, R.qLen + add)); big.set(R.q[k].subarray(R.qOff, R.qOff + R.qLen)); R.q[k] = big; }
      else for (const q of R.q) q.copyWithin(0, R.qOff, R.qOff + R.qLen);
      R.qOff = 0;
    }
    for (let k = 0; k < 2; k++) R.q[k].set(o.subarray(k * made + from, (k + 1) * made), R.qOff + R.qLen);
    R.qLen += add;
  }
  out.set(R.q[0].subarray(R.qOff, R.qOff + n), 0);
  out.set(R.q[1].subarray(R.qOff, R.qOff + n), stride);
  R.qOff += n;
  R.qLen -= n;
  R.qStart = p + n;
}

function sesMixer(s) {
  const solo = s.tracks.some(tr => tr.solo), keep = new Set();
  const act = s.tracks.filter(tr => !tr.mute && (!solo || tr.solo)).map(tr => {
    const rack = sesRack(tr.id, tr.fx, s.sr);
    if (rack) keep.add(tr.id);
    const g = tr.gain <= -96 ? 0 : Math.pow(10, tr.gain / 20);
    if (SES.scn) {
      const docs = s.scenes.rows.map(r => r.slots[tr.id]).filter(Boolean);
      const mono = docs.every(k => { const c = SES.docs.get(k.doc); return !c || c.meta.channels === 1; });
      return { g, pan: tr.pan, clips: [], dyn: (p, n) => scClips(tr.id, p, n), xf: new Map(), rack, mono, vol: null, pn: null };
    }
    const mono = tr.clips.every(k => { const c = SES.docs.get(k.doc); return !c || c.meta.channels === 1; });
    const P = SES.punch, clips = P && P.tr === tr.id ? smHole(tr.clips, P.a, P.b) : tr.clips;
    return {
      g, pan: tr.pan, clips, xf: smXfades(clips), rack, mono,
      vol: tr.touch === "vol" || !tr.auto.vol.length ? null : tr.auto.vol, pn: tr.touch === "pan" || !tr.auto.pan.length ? null : tr.auto.pan
    };
  });
  const master = sesRack("master", s.master && s.master.fx, s.sr);
  if (master) keep.add("master");
  for (const tr of s.tracks) if (tr.fx && tr.fx.on && (tr.mute || (solo && !tr.solo))) keep.add(tr.id);
  sesRackClear(keep);
  SES.anyFx = keep.size > 0;
  let buf = new Float32Array(0), gv = new Float32Array(0), pv = new Float32Array(0), dry = new Float32Array(0);
  const clipsInto = (T, p, n, dst, stride, wet) => {
    for (const k of T.dyn ? T.dyn(p, n) : T.clips) {
      const a = Math.max(p, k.at), b = Math.min(p + n, k.at + k.len);
      if (b <= a) continue;
      const c = SES.docs.get(k.doc);
      if (!c) continue;
      const m = b - a, ch = c.meta.channels, s0 = k.from + (a - k.at);
      if (buf.length < m * 2) buf = new Float32Array(m * 2);
      const rd = (src, cc, f, q, o, off) => readSrcOf(c, src, cc, f, q, o, off);
      readList(c.lists[0], c.cum[0], s0, m, buf, 0, rd);
      if (ch > 1) readList(c.lists[1], c.cum[1], s0, m, buf, m, rd);
      const kg = k.gain <= -96 ? 0 : Math.pow(10, k.gain / 20), g = wet ? kg : (T.vol ? 1 : T.g) * kg;
      const [pl, pr] = wet ? [1, 1] : smPanGains(T.pan, ch === 1);
      const o = a - p, q0 = a - k.at, R = ch > 1 ? m : 0, fi = k.fin, fo = k.fout, len = k.len, x = T.xf.get(k.id) || { xi: 0, xo: 0 };
      for (let i = 0; i < m; i++) {
        const q = q0 + i;
        let f = 1;
        if (fi > 0 && q < fi) f *= fadeGain(q / Math.max(1, fi - 1), "lin", 0);
        if (fo > 0 && q >= len - fo) f *= fadeGain((len - 1 - q) / Math.max(1, fo - 1), "lin", 0);
        if (x.xi) f *= smXin(q, x.xi);
        if (x.xo) f *= smXout(q, len, x.xo);
        let gl = pl, gr = pr;
        if (!wet && T.pn) { const v = pv[o + i]; if (ch === 1) { const th = (v + 1) * Math.PI / 4; gl = Math.cos(th); gr = Math.sin(th); } else { gl = v > 0 ? 1 - v : 1; gr = v < 0 ? 1 + v : 1; } }
        const gg = g * f * (!wet && T.vol ? gv[o + i] : 1);
        dst[o + i] += buf[i] * gl * gg;
        dst[stride + o + i] += buf[R + i] * gr * gg;
      }
    }
  };
  const tracks = (p, n, out, stride) => {
    out.fill(0, 0, n);
    out.fill(0, stride, stride + n);
    if (gv.length < n) { gv = new Float32Array(n); pv = new Float32Array(n); }
    if (dry.length < n * 2) dry = new Float32Array(n * 2);
    for (const T of act) {
      if (!T.vol && !T.g) continue;
      if (T.vol) { smBlock(T.vol, p, n, gv); for (let i = 0; i < n; i++) gv[i] = smGain(gv[i]); }
      if (T.pn) smBlock(T.pn, p, n, pv);
      if (!T.rack) { clipsInto(T, p, n, out, stride, false); continue; }
      sesRackRun(T.rack, (q, m, d, st) => { d.fill(0, 0, m); d.fill(0, st, st + m); clipsInto(T, q, m, d, st, true); }, p, n, dry, n);
      for (let i = 0; i < n; i++) {
        const g = T.vol ? gv[i] : T.g, v = T.pn ? pv[i] : T.pan;
        let gl, gr;
        if (T.mono) { const th = (v + 1) * Math.PI / 4; gl = Math.cos(th); gr = Math.sin(th); } else { gl = v > 0 ? 1 - v : 1; gr = v < 0 ? 1 + v : 1; }
        out[i] += dry[i] * gl * g;
        out[stride + i] += dry[n + i] * gr * g;
      }
    }
  };
  if (!master) return tracks;
  return (p, n, out, stride) => sesRackRun(master, tracks, p, n, out, stride);
}

function scSlot(k) {
  if (!k || typeof k !== "object" || !k.doc) return null;
  return { id: String(k.id), doc: String(k.doc), from: Math.max(0, Math.floor(Number(k.from) || 0)), len: Math.max(1, Math.floor(Number(k.len) || 1)), loop: k.loop !== false, gain: Number(k.gain) || 0 };
}

function scClips(tid, p, n) {
  const L = SES.scn && SES.scn.ev.get(tid), out = [];
  if (!L) return out;
  const sr = SES.s.sr || 48000, F = Math.max(2, Math.round(sr * 0.003)), e1 = p + n;
  for (let i = 0; i < L.length; i++) {
    const k = L[i].k, a0 = L[i].at, a1 = i + 1 < L.length ? L[i + 1].at : Infinity;
    if (!k || a1 <= p || a0 >= e1) continue;
    const b0 = a0 - (L[i].off || 0) % k.len;
    const add = (s0, j) => {
      const s = Math.max(s0, a0), e = Math.min(s0 + k.len, a1), len = e - s;
      if (len < 1 || e <= p || s >= e1) return;
      out.push({ id: k.id + "#" + j, doc: k.doc, at: s, from: k.from + (s - s0), len, gain: k.gain, fin: s === a0 ? Math.min(F, len) : 0, fout: e < s0 + k.len || !k.loop ? Math.min(F, len) : 0 });
    };
    if (!k.loop) { add(b0, 0); continue; }
    for (let j = Math.max(0, Math.floor((p - b0) / k.len)); b0 + j * k.len < Math.min(a1, e1); j++) add(b0 + j * k.len, j);
  }
  return out;
}

function scLaunch(m) {
  if (!play || !play.mix || !ring || !SES.scn || !SES.s) return;
  const sr = SES.s.sr || 48000, ctrl = ring.ctrl, r = Atomics.load(ctrl, 2);
  const min = r + Math.max(2048, Math.round(sr * 0.06)) + 256, q = Math.max(0, Math.floor(Number(m.q) || 0));
  const at = q > 0 ? Math.ceil(min / q) * q : min, done = [];
  for (const it of Array.isArray(m.items) ? m.items : []) {
    const tid = String(it.tr), k = scSlot(it.k);
    const L = (SES.scn.ev.get(tid) || []).filter(e => e.at < at);
    while (L.length > 1 && L[1].at <= r) L.shift();
    const ref = it.cont && typeof it.cont === "object" ? it.cont : null, off = ref ? Math.max(0, Math.floor(at - Number(ref.at) + (Number(ref.off) || 0))) : 0;
    L.push({ at, k, off });
    SES.scn.ev.set(tid, L);
    done.push({ tr: tid, at, k: k ? k.id : null, off });
  }
  sesFlush();
  postMessage({ t: "sclaunched", items: done });
}

async function scLufs(m) {
  const c = SES.docs.get(String(m.doc));
  if (!c) throw new Error("stale");
  const x = await dspExports(), ch = c.meta.channels, a = clampI(m.from, 0, c.len), b = clampI(Number(m.from) + Number(m.len), 0, c.len);
  if (b <= a) throw new Error("nothing");
  if (x.lm_open(ch, c.meta.sampleRate) !== 0) throw new Error(dspError(x));
  const rd = (src, cc, f, k, out, off) => readSrcOf(c, src, cc, f, k, out, off), B = 65536;
  let i = 0;
  for (let s = a; s < b; s += B) {
    const n = Math.min(B, b - s), p = x.lm_in(n, ch), inb = new Float32Array(x.memory.buffer, p, n * ch);
    for (let k = 0; k < ch; k++) readList(c.lists[k], c.cum[k], s, n, inb, k * n, rd);
    if (x.lm_feed(n) !== 0) throw new Error(dspError(x));
    if (++i % 16 === 0) await new Promise(r => setTimeout(r, 0));
  }
  return { t: "sclufs", lufs: ldStatsOut(x).integrated };
}

function scRead(m) {
  const c = SES.docs.get(String(m.doc));
  if (!c) throw new Error("stale");
  const ch = c.meta.channels, a = clampI(m.from, 0, c.len), n = clampI(m.len, 0, Math.min(c.len - a, c.meta.sampleRate * 120));
  const out = new Float32Array(n * ch), rd = (src, cc, f, k, o, off) => readSrcOf(c, src, cc, f, k, o, off);
  for (let k = 0; k < ch; k++) readList(c.lists[k], c.cum[k], a, n, out, k * n, rd);
  return { t: "scread", ch, n, sr: c.meta.sampleRate, data: out };
}

function sesRackMeter(key) {
  const R = SES_RK.racks.get(key);
  if (!R) return { t: "rkmeter", on: false };
  const v = new Float64Array(R.x.memory.buffer, R.x.rk_info(R.slot), 4);
  const out = { t: "rkmeter", on: true, comp: v[0], lim: v[1], match: 0, ds: v[3] };
  v[0] = 0;
  v[1] = 0;
  v[3] = 0;
  return out;
}

function sesSetMix(m) {
  if (!SES.s) return;
  const s = sesClean(m.s);
  if (s.id !== SES.s.id) return;
  SES.s = s;
  SES.mix = sesMixer(s);
  if (m.flush) sesFlush();
}

async function sesPut(m) {
  const s = sesClean(m.s);
  await sesWrite(s);
  if (SES.s && SES.s.id === s.id) { SES.s = s; SES.mix = sesMixer(s); }
  return { t: "sesput", s };
}

async function sesNew(m) {
  const s = sesClean({ name: m.name, sr: m.sr, tracks: m.tracks || [], marks: m.marks || [], src: m.src || null });
  await sesWrite(s);
  return { t: "sesnew", s };
}

async function sesDel(m) {
  const id = String(m.id).replace(/[^\w-]/g, "");
  if (SES.s && SES.s.id === m.id) { stopPlay(); sesRelease(); SES.s = null; SES.mix = null; }
  try { await (await sessionsDir()).removeEntry(id + ".json"); } catch {}
  return { t: "sesdel", id: m.id };
}

function sesClose() {
  if (play && play.mix) stopPlay();
  sesRelease();
  SES.s = null;
  SES.mix = null;
  return { t: "sesclosed" };
}

function sesStartPlay(m) {
  stopPlay();
  if (!SES.s || !SES.mix || !ring) return;
  const P = m.punch && typeof m.punch === "object" ? { tr: String(m.punch.tr), a: Math.max(0, Math.floor(Number(m.punch.a) || 0)), b: Number(m.punch.b) >= 0 ? Math.floor(Number(m.punch.b)) : -1 } : null;
  const scn = m.scenes ? { ev: new Map() } : null;
  if (scn) for (const it of Array.isArray(m.items) ? m.items : []) scn.ev.set(String(it.tr), [{ at: 0, k: scSlot(it.k), off: Math.max(0, Math.floor(Number(it.off) || 0)) }]);
  if (P || SES.punch || scn || SES.scn) { SES.punch = P; SES.scn = scn; SES.mix = sesMixer(SES.s); }
  const F = m.rec || m.scenes ? Math.max(sesLen(SES.s), Math.floor(Number(m.end) || 0)) : sesLen(SES.s);
  const start = Math.max(0, Math.min(Math.floor(m.start), F)), end = Math.max(start, Math.min(Math.floor(m.end), F));
  if (end - start < 1) return;
  const loop = !!m.loop;
  play = { start, end, loop, off: loop ? Math.max(0, Math.min(end - start - 1, Math.floor(m.off || 0))) : 0, tmp: new Float32Array(CHUNK * 2), mix: true };
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
    if (Atomics.load(ring.ctrl, 0) !== 1) { stopPlay(); return; }
    try { fillRing(); } catch (e) { stopPlay(); postMessage({ t: "playerror", msg: errText(e) }); }
  }, 8);
}

function sesJob(m) {
  if (SES.job) SES.job.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 };
  SES.job = job;
  job.tick = async frac => {
    const now = performance.now();
    if (now - job.last > 120) { job.last = now; postMessage({ t: "sprog", id: job.id, frac: Math.min(1, frac) }); await new Promise(r => setTimeout(r, 0)); }
    if (job.cancel) throw new Error("cancelled");
  };
  job.done = () => { if (SES.job === job) SES.job = null; };
  return job;
}

async function sesNewDoc(name, sr, ch, frames, fill, job, extra) {
  const dir = await docsDir(), id = crypto.randomUUID(), docDir = await dir.getDirectoryHandle(id, { create: true });
  let pool = null;
  try {
    pool = await (await docDir.getFileHandle("pool.f32", { create: true })).createSyncAccessHandle();
    const S = sinkNew(pool, ch, sr);
    let peak = 0;
    await fill((o, n) => { for (let i = 0; i < n * ch; i++) { const v = o[i] < 0 ? -o[i] : o[i]; if (v > peak) peak = v; } sinkPush(S, o, n); });
    const { slots, slotPeaks, bands } = sinkEnd(S);
    pool.flush();
    pool.close();
    pool = null;
    await writeFile(docDir, "peaks.f32", slotPeaks);
    await writeFile(docDir, "bands.f32", bands);
    const meta = Object.assign({ v: 1, id, name: String(name || "").trim().slice(0, 160) || "Untitled", ext: "", size: frames * ch * 4, sampleRate: sr, channels: ch, bits: 32, frames, blockFrames: BLOCK, slots, created: Date.now(), opened: Date.now(), readOnly: false, tags: [] }, extra || {});
    await writeFile(docDir, "meta.json", enc(meta));
    return { meta, peak };
  } catch (e) {
    if (pool) { try { pool.close(); } catch {} }
    try { await dir.removeEntry(id, { recursive: true }); } catch {}
    throw e;
  }
}

async function sesBounce(m) {
  if (!SES.s || !SES.mix) throw new Error("stale");
  const s = SES.s, F = sesLen(s), a = clampI(m.a, 0, F), b = m.b > a ? clampI(m.b, 0, F) : F;
  if (b <= a || !s.sr) throw new Error("nothing");
  const job = sesJob(m), mix = SES.mix, N = 65536, buf = new Float32Array(N * 2), il = new Float32Array(N * 2);
  try {
    const r = await sesNewDoc(m.name, s.sr, 2, b - a, async push => {
      for (let p = a; p < b; p += N) {
        const n = Math.min(N, b - p);
        mix(p, n, buf, N);
        il.set(buf.subarray(0, n), 0);
        il.set(buf.subarray(N, N + n), n);
        push(il.subarray(0, n * 2), n);
        await job.tick((p + n - a) / (b - a));
      }
    }, job, { source: { kind: "session", from: s.id }, locs: djLocs(s.marks.filter(k => k.at >= a && k.at < b).map(k => ({ at: k.at - a, name: k.name })), b - a) });
    return { t: "bounced", meta: r.meta, peak: r.peak };
  } finally { job.done(); }
}

async function sesConvert(m) {
  const sr = clampI(m.sr, 8000, 768000);
  const docDir = await (await docsDir()).getDirectoryHandle(String(m.id));
  const meta = await readJson(docDir, "meta.json");
  let c = cur && cur.meta.id === m.id ? cur : lingering.get(m.id) || null, fresh = false;
  if (!c) { c = await loadDoc(docDir, meta); fresh = true; }
  const rateIn = c.meta.sampleRate, ch = c.meta.channels, total = c.len;
  const outFrames = Math.ceil(total * sr / rateIn);
  const job = sesJob(m), x = await dspExports(), lists = c.lists, cum = c.cum;
  const rd = (src, cc, f, q, o, off) => readSrcOf(c, src, cc, f, q, o, off);
  try {
    if (x.rs_open(rateIn, sr, ch) !== 0) throw new Error(dspError(x));
    const r = await sesNewDoc(c.meta.name.replace(/\.[^.]+$/, "") + " (" + (sr / 1000) + " kHz)", sr, ch, outFrames, async push => {
      const need = x.rs_need(), sIn = x.rs_in_stride(), sOut = x.rs_out_stride();
      let skip = x.rs_delay(), pos = 0, emitted = 0, tmp = null;
      while (emitted < outFrames) {
        const take = Math.max(0, Math.min(need, total - pos));
        const inV = new Float32Array(x.memory.buffer, x.rs_in(), sIn * ch);
        for (let cc = 0; cc < ch; cc++) {
          if (take) readList(lists[cc], cum[cc], pos, take, inV, cc * sIn, rd);
          inV.fill(0, cc * sIn + take, cc * sIn + need);
        }
        pos += take;
        const k = x.rs_process(need);
        if (k < 0) throw new Error(dspError(x));
        const outV = new Float32Array(x.memory.buffer, x.rs_out(), sOut * ch);
        let st = 0;
        if (skip) { st = Math.min(skip, k); skip -= st; }
        const q = Math.min(k - st, outFrames - emitted);
        if (q > 0) {
          if (!tmp || tmp.length < q * ch) tmp = new Float32Array(Math.max(q, need * 2) * ch);
          for (let cc = 0; cc < ch; cc++) tmp.set(outV.subarray(cc * sOut + st, cc * sOut + st + q), cc * q);
          push(tmp.subarray(0, q * ch), q);
          emitted += q;
        }
        await job.tick(emitted / outFrames);
      }
      x.rs_close();
    }, job, { source: { kind: "derived", from: c.meta.id }, tags: c.meta.tags || [], bits: c.meta.bits });
    return { t: "converted", meta: r.meta };
  } catch (e) {
    try { x.rs_close(); } catch {}
    throw e;
  } finally {
    job.done();
    if (fresh) closeHandles(c);
  }
}

const DJ_WIN = 4, DJ_RATE = 4000, DJ_MAXLAG = 1.5, DJ_MINLAG = 0.05, DJ_SCORE = 10, DJ_AGREE = 0.025;

async function djWav(f) {
  const n = Math.min(f.size, 1 << 18), b = new Uint8Array(await f.slice(0, n).arrayBuffer()), v = new DataView(b.buffer);
  const id = o => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);
  const txt = (o, l) => { let s = ""; for (let i = o; i < o + l && b[i]; i++) s += String.fromCharCode(b[i]); return s.trim(); };
  if (n < 12 || id(0) !== "RIFF" || id(8) !== "WAVE") throw new Error("notwav|" + f.name);
  let p = 12, fmt = null, bext = null;
  while (p + 8 <= n) {
    const cid = id(p), size = v.getUint32(p + 4, true), q = p + 8;
    if (cid === "fmt " && q + 16 <= n) {
      let tag = v.getUint16(q, true);
      if (tag === 0xfffe && size >= 26 && q + 26 <= n) tag = v.getUint16(q + 24, true);
      fmt = { tag, ch: v.getUint16(q + 2, true), sr: v.getUint32(q + 4, true), align: v.getUint16(q + 12, true), bits: v.getUint16(q + 14, true) };
    } else if (cid === "bext" && q + 346 <= n) {
      bext = { desc: txt(q, 256), orig: txt(q + 256, 32), oref: txt(q + 288, 32), ref: v.getUint32(q + 338, true) + v.getUint32(q + 342, true) * 4294967296 };
    } else if (cid === "data") {
      if (!fmt) break;
      const ok = (fmt.tag === 1 && [16, 24, 32].includes(fmt.bits)) || (fmt.tag === 3 && fmt.bits === 32);
      if (!ok || !fmt.ch || fmt.align !== fmt.ch * fmt.bits / 8 || fmt.sr < 8000) throw new Error("format|" + f.name);
      const left = f.size - q, len = size && size <= left ? size : left;
      return { file: f, name: f.name, fmt, off: q, frames: Math.floor(len / fmt.align), bext };
    }
    p = q + size + (size & 1);
  }
  throw new Error("nodata|" + f.name);
}

function djDecode(u8, fmt, n, out, stride, at) {
  const ch = fmt.ch;
  if (fmt.bits === 24) {
    let o = 0;
    for (let f = 0; f < n; f++) for (let c = 0; c < ch; c++, o += 3) { let x = u8[o] | (u8[o + 1] << 8) | (u8[o + 2] << 16); if (x & 0x800000) x -= 0x1000000; out[c * stride + at + f] = x / 8388608; }
    return;
  }
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (fmt.tag === 3) { for (let f = 0; f < n; f++) for (let c = 0; c < ch; c++) out[c * stride + at + f] = dv.getFloat32((f * ch + c) * 4, true); return; }
  if (fmt.bits === 16) { for (let f = 0; f < n; f++) for (let c = 0; c < ch; c++) out[c * stride + at + f] = dv.getInt16((f * ch + c) * 2, true) / 32768; return; }
  for (let f = 0; f < n; f++) for (let c = 0; c < ch; c++) out[c * stride + at + f] = dv.getInt32((f * ch + c) * 4, true) / 2147483648;
}

function djFull(fmt) { return fmt.tag === 3 ? 1 : (2 ** (fmt.bits - 1) - 1) / 2 ** (fmt.bits - 1); }

function djReader(parts) {
  const fmt = parts[0].fmt, ch = fmt.ch;
  let i = 0, pos = 0;
  return {
    ch,
    async read(n, out) {
      let got = 0;
      while (got < n && i < parts.length) {
        const P = parts[i], take = Math.min(n - got, P.frames - pos);
        if (take <= 0) { i++; pos = 0; continue; }
        const u8 = new Uint8Array(await P.file.slice(P.off + pos * fmt.align, P.off + (pos + take) * fmt.align).arrayBuffer());
        if (u8.length < take * fmt.align) throw new Error("nodata|" + P.name);
        djDecode(u8, fmt, take, out, n, got);
        pos += take;
        got += take;
      }
      for (let c = 0; c < ch; c++) out.fill(0, c * n + got, c * n + n);
      return got;
    }
  };
}

function djFrames(list) {
  const f0 = list[0].fmt;
  for (const p of list) if (p.fmt.sr !== f0.sr || p.fmt.ch !== f0.ch || p.fmt.bits !== f0.bits || p.fmt.tag !== f0.tag) throw new Error("mismatch|" + p.name);
  return list.reduce((s, p) => s + p.frames, 0);
}

async function djProbe(m) {
  const out = [];
  for (const g of m.groups || []) {
    try {
      const mp = [], ap = [];
      for (const f of g.mix || []) mp.push(await djWav(f));
      for (const f of g.atmo || []) ap.push(await djWav(f));
      const M = djFrames(mp), A = ap.length ? djFrames(ap) : 0;
      out.push({ key: g.key, sr: mp[0].fmt.sr, ch: mp[0].fmt.ch, frames: M, atmo: A, dj: !!(mp[0].bext && mp[0].bext.orig === "Delicate DJ"), date: mp[0].bext ? mp[0].bext.ref : null });
    } catch (e) {
      out.push({ key: g.key, err: errText(e) });
    }
  }
  return { t: "djprobe", recs: out };
}

function djFft(re, im, inv) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const h = len >> 1, ang = (inv ? 2 : -2) * Math.PI / len;
    for (let k = 0; k < h; k++) {
      const wr = Math.cos(ang * k), wi = Math.sin(ang * k);
      for (let i = k; i < n; i += len) {
        const b = i + h, xr = re[b] * wr - im[b] * wi, xi = re[b] * wi + im[b] * wr;
        re[b] = re[i] - xr; im[b] = im[i] - xi; re[i] += xr; im[i] += xi;
      }
    }
  }
}

function djLag(x, y, rate) {
  const L = x.length;
  let N = 1;
  while (N < 2 * L) N <<= 1;
  const xr = new Float64Array(N), xi = new Float64Array(N), yr = new Float64Array(N), yi = new Float64Array(N);
  for (let i = 1; i < L; i++) { xr[i] = x[i] - x[i - 1]; yr[i] = y[i] - y[i - 1]; }
  djFft(xr, xi, false);
  djFft(yr, yi, false);
  for (let i = 0; i < N; i++) {
    const r = xr[i] * yr[i] + xi[i] * yi[i], q = xr[i] * yi[i] - xi[i] * yr[i], a = Math.hypot(r, q);
    xr[i] = a > 1e-20 ? r / a : 0;
    xi[i] = a > 1e-20 ? q / a : 0;
  }
  djFft(xr, xi, true);
  const lo = -Math.round(DJ_MINLAG * rate), hi = Math.round(DJ_MAXLAG * rate), at = k => xr[(k + N) % N];
  let best = lo, bv = -Infinity, s2 = 0;
  for (let k = lo; k <= hi; k++) { const v = at(k); s2 += v * v; if (v > bv) { bv = v; best = k; } }
  const rms = Math.sqrt(s2 / (hi - lo + 1));
  if (!(rms > 0) || !(bv > 0)) return { lag: 0, score: 0 };
  const a = at(best - 1), b = at(best), c = at(best + 1), den = a - 2 * b + c;
  return { lag: best + (den < 0 ? Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / den)) : 0), score: bv / rms };
}

function djAlign(wins, q, rate) {
  const all = wins.map(w => djLag(w.x, w.y, rate)).filter(r => r.score >= DJ_SCORE).map(r => r.lag * q).sort((a, b) => a - b);
  const mid = all.length ? all[all.length >> 1] : 0, tol = DJ_AGREE * rate * q, got = all.filter(v => Math.abs(v - mid) <= tol);
  if (got.length < Math.min(3, wins.length) || got.length * 3 < wins.length) return { lag: 0, found: false, used: got.length, of: wins.length };
  const med = got[got.length >> 1];
  return { lag: Math.round(med), found: true, used: got.length, of: wins.length, spread: Math.round(got[got.length - 1] - got[0]) };
}

function djLocs(marks, len) {
  return (Array.isArray(marks) ? marks : []).filter(k => k && Number.isFinite(k.at) && k.at >= 0 && k.at <= len).sort((a, b) => a.at - b.at).slice(0, 999).map((k, i) => ({ id: i + 1, n: i + 1, kind: "point", a: Math.round(k.at), name: String(k.name || "").slice(0, 160), view: null, chans: null }));
}

async function djImport(m) {
  const mixP = [], atP = [];
  for (const f of m.mix || []) mixP.push(await djWav(f));
  for (const f of m.atmo || []) atP.push(await djWav(f));
  if (!mixP.length) throw new Error("nodata|");
  const M = djFrames(mixP), A = atP.length ? djFrames(atP) : 0, fm = mixP[0].fmt, sr = fm.sr;
  if (A && atP[0].fmt.sr !== sr) throw new Error("mismatch|" + atP[0].name);
  const bm = mixP[0].bext, ba = A ? atP[0].bext : null, d = bm && ba ? ba.ref - bm.ref : 0;
  const dj = !!(bm && ba && bm.orig === "Delicate DJ" && ba.orig === "Delicate DJ"), full = djFull(fm);
  const job = sesJob(m), N = 65536, mr = djReader(mixP), ar = A ? djReader(atP) : null, mch = mr.ch, ach = ar ? ar.ch : 0;
  const mbuf = new Float32Array(N * mch), abuf = new Float32Array(N * Math.max(1, ach));
  const s0 = Math.max(0, d), s1 = Math.min(M, d + A), q = Math.max(1, Math.round(sr / DJ_RATE)), Lw = Math.floor(DJ_WIN * sr / q), Wf = Lw * q;
  const K = dj && s1 - s0 > Wf * 2 ? Math.min(12, Math.floor((s1 - s0) / (Wf * 1.5))) : 0, wins = [];
  for (let j = 0; j < K; j++) wins.push({ s: s0 + Math.floor((s1 - s0 - Wf) * (j + 0.5) / K), x: new Float32Array(Lw), y: new Float32Array(Lw) });
  const total = M + A, rec = String(m.rec || "").slice(0, 80);
  let clipped = 0, done = 0;
  const atmoOnly = async (pushA, from, to) => {
    for (let p = from; p < to; p += N) {
      const k = Math.min(N, to - p);
      await ar.read(k, abuf);
      pushA(abuf.subarray(0, k * ach), k);
      done += k;
      await job.tick(done / total);
    }
  };
  const run = async (pushM, pushA) => {
    if (ar && d < 0) await atmoOnly(pushA, 0, -d);
    for (let p = 0; p < M; p += N) {
      const n = Math.min(N, M - p);
      await mr.read(n, mbuf);
      const a0 = ar ? Math.max(p, d) : 0, a1 = ar ? Math.min(p + n, d + A) : 0;
      if (a1 > a0) {
        const k = a1 - a0, o = a0 - p;
        await ar.read(k, abuf);
        if (dj) {
          for (let c = 0; c < mch; c++) {
            const mo = c * n + o, ao = (ach === mch ? c : 0) * k;
            for (let j = 0; j < k; j++) { const v = mbuf[mo + j]; if (v >= full || v <= -full) clipped++; mbuf[mo + j] = v - abuf[ao + j]; }
          }
        }
        for (const w of wins) {
          const g1 = Math.min(a1, w.s + Wf);
          for (let g = Math.max(a0, w.s); g < g1; g++) {
            const j = Math.floor((g - w.s) / q);
            let sm = 0, sa = 0;
            for (let c = 0; c < mch; c++) sm += mbuf[c * n + g - p];
            for (let c = 0; c < ach; c++) sa += abuf[c * k + g - a0];
            w.x[j] += sm / (mch * q);
            w.y[j] += sa / (ach * q);
          }
        }
        pushA(abuf.subarray(0, k * ach), k);
        done += k;
      }
      pushM(mbuf.subarray(0, n * mch), n);
      done += n;
      await job.tick(done / total);
    }
    if (ar && d + A > M) await atmoOnly(pushA, Math.max(0, M - d), A);
  };
  let am = null;
  try {
    const rm = await sesNewDoc(m.mixName, sr, mch, M, async pushM => {
      if (!ar) { await run(pushM, null); return; }
      am = (await sesNewDoc(m.atmoName, sr, ach, A, pushA => run(pushM, pushA), job, { source: { kind: "dj", rec, part: "atmo" }, bits: atP[0].fmt.bits })).meta;
    }, job, { source: { kind: "dj", rec, part: "mix" }, bits: fm.bits, locs: djLocs(m.marks, M) });
    return { t: "djimported", mix: rm.meta, atmo: am, offset: d, subtracted: dj, clipped, align: K ? djAlign(wins, q, sr / q) : null, sr };
  } catch (e) {
    if (am) { try { await (await docsDir()).removeEntry(am.id, { recursive: true }); } catch {} }
    throw e;
  } finally { job.done(); }
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
  return tgClean(v, true);
}

function markList(v, rateIn, rateOut, n) {
  const out = [], k = rateOut / rateIn;
  for (const m of Array.isArray(v) ? v.slice(0, 999) : []) {
    if (!m || !Number.isFinite(m.a)) continue;
    const a = Math.round(Math.max(0, m.a) * k), b = Number.isFinite(m.b) && m.b > m.a ? Math.round(m.b * k) : 0;
    if (a >= n) continue;
    out.push({ a, b: b ? Math.min(n, b) : 0, name: String(m.name || "").slice(0, 120), isrc: String(m.isrc || "").slice(0, 12) });
  }
  return out;
}

function picOf(p) {
  if (!p || !p.data) return null;
  const data = p.data instanceof ArrayBuffer ? new Uint8Array(p.data) : ArrayBuffer.isView(p.data) ? new Uint8Array(p.data.buffer, p.data.byteOffset, p.data.byteLength) : null;
  if (!data || !data.length || data.length > 4 << 20) return null;
  return { mime: /^image\/(jpeg|png)$/.test(p.mime) ? p.mime : "image/jpeg", w: Math.max(0, p.w | 0), h: Math.max(0, p.h | 0), data };
}

function flacMeta(tags, pic, cue) {
  const enc = new TextEncoder(), blocks = [];
  if (cue) blocks.push([5, cue]);
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

function wavTail(job) {
  return tgCat([tgWavInfo(job.tags), job.marks.length ? tgWavCue(job.marks) : new Uint8Array(0)]);
}

function wavBext(job, rate, ch, bits) {
  if (!job.bext) return new Uint8Array(0);
  const title = (job.tags.find(p => p[0] === "TITLE") || [])[1] || job.name.replace(/\.[^.]+$/, "");
  return tgBext({ description: title, ref: Math.round(job.a * rate / job.c.meta.sampleRate), history: "A=PCM,F=" + rate + ",W=" + bits + ",M=" + (ch === 1 ? "mono" : ch === 2 ? "stereo" : ch + "ch") + ",T=Delicate Studio\r\n" });
}

function wavHeader(frames, ch, rate, bits, float, extra, pre) {
  const bps = bits >> 3, align = ch * bps, data = frames * align, pad = data % 2;
  const ext = !float && ch > 2;
  const fmtLen = float ? 18 : ext ? 40 : 16, factLen = float ? 12 : 0, preLen = pre ? pre.length : 0;
  const size = 12 + 36 + 8 + fmtLen + factLen + preLen + 8;
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
  if (preLen) { new Uint8Array(b, o, preLen).set(pre); o += preLen; }
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
      const ranges = job.marks.filter(m => m.b > m.a);
      meta = flacMeta(job.tags, job.pic, ranges.length ? tgFlacCue(ranges, outFrames) : null);
      const n = x.fl_header(meta.length ? 0 : 1);
      if (n < 0) throw new Error(dspError(x));
      putAt(hd, new Uint8Array(x.memory.buffer, x.fl_out(), n).slice(), 0);
      fileOff = n;
      if (meta.length) { putAt(hd, meta, fileOff); fileOff += meta.length; }
    } else {
      info = wavTail(job);
      const w = wavHeader(outFrames, ch, rateOut, bits, float, info.length, wavBext(job, rateOut, ch, bits));
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

async function queueExport(m) {
  let c = cur && cur.meta.id === m.id ? cur : lingering.get(m.id) || null, fresh = false;
  if (!c) {
    const docDir = await (await docsDir()).getDirectoryHandle(String(m.id));
    c = await loadDoc(docDir, await readJson(docDir, "meta.json"));
    fresh = true;
  }
  const a = clampI(m.a, 0, c.len), b = clampI(m.b, 0, c.len);
  if (b <= a) { if (fresh) closeHandles(c); throw new Error("nosel"); }
  if (fresh) lingering.set(c.meta.id, c);
  const f = m.fmt || {};
  const type = f.type === "flac" ? "flac" : "wav";
  const bits = type === "flac" ? (f.bits === 16 ? 16 : 24) : [16, 24, 32].includes(f.bits) ? f.bits : 24;
  const rate = [0, 44100, 48000, 88200, 96000, 176400, 192000].includes(f.rate) ? f.rate : 0;
  const rateOut = rate || c.meta.sampleRate, nOut = rateOut === c.meta.sampleRate ? b - a : Math.ceil((b - a) * rateOut / c.meta.sampleRate);
  const job = { id: m.jobId, c, lists: c.lists, a, b, name: String(m.name || "export"), fmt: { type, bits, rate }, master: m.master || {}, dest: m.dest || { kind: "download" }, tags: tagList(m.tags), pic: type === "flac" ? picOf(m.pic) : null, marks: markList(m.marks, c.meta.sampleRate, rateOut, nOut), bext: type === "wav" && m.bext !== false, file: m.jobId + "." + type, state: "queued", frac: 0, seed: XP.jobs.length * 7919 };
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

const RK_BANDS = 8, RK_LEN = 84, RK_TYPES = ["bell", "lowshelf", "highshelf", "notch"], RK_MODS = ["off", "chorus", "flanger", "phaser"];

function rkSp(o) {
  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const md = o.mod || {}, dl = o.delay || {}, rv = o.rev || {}, gt = o.gate || {}, ds = o.ds || {};
  const note = v => typeof v === "string" && /^(free|\d+\/\d+d?)$/.test(v) ? v : "free";
  return {
    bpm: num(o.bpm, 40, 240, 120),
    mod: { mode: RK_MODS.includes(md.mode) ? md.mode : "off", rate: num(md.rate, 0.01, 20, 0.5), depth: num(md.depth, 0, 1, 0.5), fb: num(md.fb, 0, 0.95, 0.5), mix: num(md.mix, 0, 1, 0.5) },
    delay: { on: !!dl.on, ms: num(dl.ms, 1, 2000, 250), fb: num(dl.fb, 0, 0.95, 0.45), mix: num(dl.mix, 0, 1, 0.35), pp: !!dl.pp, note: note(dl.note) },
    rev: { on: !!rv.on, decay: num(rv.decay, 0.1, 20, 2), damp: num(rv.damp, 0, 1, 0.5), pre: num(rv.pre, 0, 200, 10), mix: num(rv.mix, 0, 1, 0.25), cut: num(rv.cut, 10, 2000, 180) },
    gate: { on: !!gt.on, rate: num(gt.rate, 0.05, 40, 4), depth: num(gt.depth, 0, 1, 1), square: gt.square !== false, note: note(gt.note) },
    ds: { on: !!ds.on, f: num(ds.f, 1000, 16000, 6000), thr: num(ds.thr, -60, 0, -30), range: num(ds.range, 0, 24, 6) }
  };
}

function rkWarm(x, slot, lat, sr) { return lat + Math.max(Math.round(sr * 0.5), Math.min(x.rk_tail(slot), sr * 8)); }

function rkCfg(m) {
  const o = m && typeof m === "object" ? m : {};
  const num = (v, lo, hi, d) => { const x = Number(v); return Number.isFinite(x) ? Math.max(lo, Math.min(hi, x)) : d; };
  const on = v => v ? 1 : 0;
  const ord = v => [2, 4, 8].includes(Number(v)) ? Number(v) : 4;
  const hp = o.hp || {}, lp = o.lp || {}, cp = o.comp || {}, lm = o.lim || {};
  const a = new Float64Array(RK_LEN);
  a.set([on(hp.on), num(hp.f, 10, 2000, 30), ord(hp.ord), on(lp.on), num(lp.f, 1000, 24000, 18000), ord(lp.ord),
    on(cp.on), num(cp.thr, -80, 0, -18), num(cp.ratio, 1, 100, 3), num(cp.knee, 0, 40, 6), num(cp.att, 0.1, 500, 5), num(cp.rel, 5, 5000, 150), num(cp.makeup, -24, 40, 0),
    on(lm.on), num(lm.ceil, -12, 0, -1), num(lm.look, 0.5, 20, 2), num(lm.rel, 1, 2000, 100), num(o.out, -24, 24, 0), on(o.match)]);
  const bands = (Array.isArray(o.bands) ? o.bands : []).slice(0, RK_BANDS);
  a[19] = bands.length;
  bands.forEach((b, k) => {
    const t = Math.max(0, RK_TYPES.indexOf(b && b.type));
    a.set([on(b && b.on !== false), t, num(b && b.f, 20, 22000, 1000), num(b && b.g, -30, 30, 0), num(b && b.q, 0.1, 40, 0.71)], 20 + 5 * k);
  });
  const sp = rkSp(o);
  a.set([RK_MODS.indexOf(sp.mod.mode), sp.mod.rate, sp.mod.depth, sp.mod.fb, sp.mod.mix,
    on(sp.delay.on), sp.delay.ms, sp.delay.fb, sp.delay.mix, on(sp.delay.pp),
    on(sp.rev.on), sp.rev.decay, sp.rev.damp, sp.rev.pre, sp.rev.mix, sp.rev.cut,
    on(sp.gate.on), sp.gate.rate, sp.gate.depth, on(sp.gate.square),
    on(sp.ds.on), sp.ds.f, sp.ds.thr, sp.ds.range], 60);
  return a;
}

function rkTune(x, slot, raw, preview) {
  const a = rkCfg(raw);
  if (!preview) a[18] = 0;
  new Float64Array(x.memory.buffer, x.rk_cfg(), RK_LEN).set(a);
  const lat = x.rk_set(slot);
  if (lat < 0) throw new Error(dspError(x));
  return lat;
}

function rkMeter() {
  const pv = FX.pv;
  if (FX.mode === "off" || FX.kind !== "rk" || !pv || pv.kind !== "rk") return { t: "rkmeter", on: false };
  const v = new Float64Array(pv.x.memory.buffer, pv.x.rk_info(0), 4);
  const out = { t: "rkmeter", on: true, comp: v[0], lim: v[1], match: v[2], ds: v[3] };
  v[0] = 0;
  v[1] = 0;
  v[3] = 0;
  return out;
}

function fxApi(x, kind, slot) {
  if (kind === "rk") return { reset: () => x.rk_reset(slot), inp: m => x.rk_in(slot, m), run: m => x.rk_run(slot, m), out: () => x.rk_out(slot) };
  if (kind === "ld") return { reset: () => x.lim_reset(slot), inp: m => x.lim_in(slot, m), run: m => x.lim_run(slot, m), out: () => x.lim_out(slot) };
  return kind === "hum"
    ? { reset: () => x.dh_reset(slot), inp: m => x.dh_in(slot, m), run: m => x.dh_run(slot, m), out: () => x.dh_out(slot) }
    : { reset: () => x.nr_reset(slot), inp: m => x.nr_in(slot, m), run: m => x.nr_run(slot, m), out: () => x.nr_out(slot) };
}

function fxKind(k) { return k === "hum" || k === "ld" || k === "rk" ? k : "nr"; }

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
  if (kind === "rk") {
    if (x.rk_open(slot, ch, sr) !== 0) throw new Error(dspError(x));
    const lat = rkTune(x, slot, raw, slot === 0);
    return { warm: rkWarm(x, slot, lat, sr), key: "rk" };
  }
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
  if (kind === "rk") pv.warm = rkWarm(x, 0, rkTune(x, 0, FX.raw, true), c.meta.sampleRate);
  else if (kind === "hum") pv.warm = humWarm(humTune(x, 0, FX.raw, only), c.meta.sampleRate);
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

function sesFlush() {
  if (!play || !play.mix || !ring || !SES.s) return;
  const ctrl = ring.ctrl, w = Atomics.load(ctrl, 1), r = Atomics.load(ctrl, 2);
  const keep = Math.max(2048, Math.round(SES.s.sr * 0.06));
  if (w - r <= keep) return;
  Atomics.store(ctrl, 1, r + keep);
  if (Atomics.load(ctrl, 2) > r + keep - 256) { Atomics.store(ctrl, 1, w); return; }
  try { fillRing(); } catch (e) { stopPlay(); postMessage({ t: "playerror", msg: errText(e) }); }
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
    const op = kind === "ld" ? (["loud", "norm", "amp"].includes(m.op) ? m.op : "amp") : kind === "rk" ? "fx" : kind;
    pushHist({ op, a, b, n: kind === "ld" ? Math.round(ldCfg(m.cfg, ch).gain * 10) / 10 : 0, ch: chans.every(Boolean) ? null : chanLabel(chans) }, next, before, before);
    persist();
    return statePayload(m.have, { t: "state", sel: null });
  });
}

const PX = { job: null };
const PX_DATA = ["fadein", "fadeout", "dc", "reverse", "invert", "mono", "msenc", "msdec"];
const PX_REF = { swap: k => 1 - k, lr: () => 0, rl: () => 1 };
const PX_DC_MIN = 1e-6;

function pxCurve(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const k = Number(o.k);
  return { shape: o.shape === "cos" ? "cos" : "lin", k: Number.isFinite(k) ? Math.max(-1, Math.min(1, k)) : 0 };
}

function pxJob(m, c) {
  if (PX.job) PX.job.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 };
  PX.job = job;
  job.tick = async frac => {
    const now = performance.now();
    if (now - job.last > 100) { job.last = now; postMessage({ t: "pprog", id: job.id, frac }); await new Promise(r => setTimeout(r, 0)); }
    if (job.cancel || cur !== c) throw new Error("cancelled");
  };
  job.done = () => { if (PX.job === job) PX.job = null; };
  return job;
}

function stMarks(marks, a, b, n) {
  const d = n - (b - a), k = n / Math.max(1, b - a);
  const at = p => p <= a ? p : p >= b ? p + d : a + Math.round((p - a) * k);
  return marks.map(m => m.kind === "view" ? m : Object.assign({}, m, { a: at(m.a), b: m.kind === "range" ? at(m.b) : m.b }));
}

async function stApply(m) {
  const c = cur;
  const x = await dspExports();
  if (cur !== c) throw new Error("stale");
  const ch = c.meta.channels, sr = c.meta.sampleRate, F = c.len;
  let a = 0, b = F;
  if (m.rb > m.ra) { a = clampI(m.ra, 0, F); b = clampI(m.rb, 0, F); }
  const speed = Math.max(0.25, Math.min(4, Number(m.speed) || 1)), semis = Math.max(-24, Math.min(24, Number(m.semis) || 0)) + Math.max(-100, Math.min(100, Number(m.cents) || 0)) / 100;
  const pitch = Math.pow(2, semis / 12);
  if (b - a < sr * 0.05) throw new Error("nosel");
  if (Math.abs(speed - 1) < 1e-6 && Math.abs(semis) < 1e-6) throw new Error("st-none");
  const total = Math.max(1, Math.round((b - a) / speed));
  const job = pxJob(m, c);
  const lists = c.lists, cums = c.cum;
  const rd = (src, cc, f, n, out, off) => readSrcOf(c, src, cc, f, n, out, off);
  const snap = { allocs: c.allocs.length, heapEnd: c.heapEnd, pkEnd: c.pkEnd, ver: c.ver };
  const CH = Math.min(1 << 20, total), FEED = 16384;
  const bufs = Array.from({ length: ch }, () => new Float32Array(CH)), segs = Array.from({ length: ch }, () => []);
  let fill = 0;
  const flush = () => { if (!fill) return; for (let k = 0; k < ch; k++) segs[k].push([allocData(bufs[k].subarray(0, fill)), 0, 0, fill]); fill = 0; };
  try {
    if (x.st_open(ch, a, speed, pitch) !== 0) throw new Error(dspError(x));
    let fed = x.st_first(), made = 0;
    while (made < total) {
      if (x.st_need() > x.st_have()) {
        const inb = wasmF32(x, x.st_in(FEED), FEED * ch);
        for (let k = 0; k < ch; k++) readList(lists[k], cums[k], fed, FEED, inb, k * FEED, rd);
        x.st_push(FEED);
        fed += FEED;
        continue;
      }
      const want = Math.min(65536, total - made, CH - fill);
      const got = x.st_run(want);
      if (got < 0) throw new Error(dspError(x));
      const out = wasmF32(x, x.st_out(), got * ch);
      for (let k = 0; k < ch; k++) bufs[k].set(out.subarray(k * got, (k + 1) * got), fill);
      fill += got;
      made += got;
      if (fill === CH) flush();
      await job.tick(made / total);
    }
    flush();
  } catch (e) {
    x.st_close();
    job.done();
    nrRollback(c, snap);
    throw e;
  }
  x.st_close();
  job.done();
  return enqueue(() => {
    if (cur !== c || c.lists !== lists) { nrRollback(c, snap); throw new Error("changed"); }
    const X = Math.max(0, Math.round((Number(m.xfade) || 0) * sr / 1000));
    const next = opReplace(c.lists, a, b, segs, X, c.io);
    const before = { a: clampI(m.a, 0, F), b: clampI(m.b, 0, F), cursor: clampI(m.cursor, 0, F) };
    const after = { a, b: a + total, cursor: a };
    pushHist({ op: "stretch", a, b, n: total, ch: null }, next, before, after, stMarks(c.hist[c.idx].marks, a, b, total));
    persist();
    return statePayload(m.have, { t: "state", sel: after });
  });
}

async function pxApply(m) {
  if (m.op === "stretch") return stApply(m);
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const op = m.op, ref = PX_REF[op] || null;
  if (!ref && !PX_DATA.includes(op)) throw new Error("unknown edit");
  const ch = c.meta.channels, sr = c.meta.sampleRate, F = c.len;
  const two = !!ref || op === "mono" || op === "msenc" || op === "msdec", fade = op === "fadein" || op === "fadeout";
  if (two && ch !== 2) throw new Error("px-stereo");
  let a, b;
  if (m.rb > m.ra) { a = clampI(m.ra, 0, F); b = clampI(m.rb, 0, F); }
  else { a = clampI(m.a, 0, F); b = clampI(m.b, 0, F); if (b < a) [a, b] = [b, a]; }
  if (b <= a) { if (fade) throw new Error("nosel"); a = 0; b = F; }
  const chans = Array.isArray(m.chans) && m.chans.length === ch && m.chans.some(Boolean) ? m.chans.map(Boolean) : new Array(ch).fill(true);
  let outs = op === "lr" ? [1] : op === "rl" ? [0] : two ? [0, 1] : chans.map((v, k) => v ? k : -1).filter(k => k >= 0);
  if (m.snap && !fade && (a > 0 || b < F)) {
    const mask = Array.from({ length: ch }, (_, k) => outs.includes(k));
    const sa = a > 0 ? snapZero(a, mask, 0) : { p: 0, d: 0 }, sb = b < F ? snapZero(b, mask, sa.d) : { p: F, d: 0 };
    if (sb.p > sa.p) { a = sa.p; b = sb.p; }
  }
  const X = fade ? 0 : Math.max(0, Math.round((Number(m.xfade) || 0) * sr / 1000));
  const xf = Math.min(X, Math.floor((b - a) / 4)), h0 = a > 0 ? xf : 0, h1 = b < F ? xf : 0, i0 = a + h0, i1 = b - h1;
  const lists = c.lists, cums = c.cum;
  const rds = (src, cc, f, n, out, off) => readSrcOf(c, src, cc, f, n, out, off);
  const rd = (k, p, n, out) => readList(lists[k], cums[k], p, n, out, 0, rds);
  const cv = pxCurve(m.cfg), n1 = Math.max(1, b - a - 1);
  const CH = Math.min(1 << 20, b - a), buf = new Float32Array(CH), tmp = two ? new Float32Array(CH) : null;
  const mean = new Float64Array(ch);
  const make = (k, p, n, o, t) => {
    if (ref) { rd(ref(k), p, n, o); return; }
    if (op === "reverse") { rd(k, a + b - p - n, n, o); o.reverse(); return; }
    if (two) {
      rd(0, p, n, o);
      rd(1, p, n, t);
      const s = op === "mono" || k === 0 ? 1 : -1, g = op === "msdec" ? 1 : 0.5;
      for (let i = 0; i < n; i++) o[i] = (o[i] + s * t[i]) * g;
      return;
    }
    rd(k, p, n, o);
    if (fade) { for (let i = 0; i < n; i++) { const x = (p + i - a) / n1; o[i] *= fadeGain(op === "fadein" ? x : 1 - x, cv.shape, cv.k); } }
    else if (op === "dc") { const d = mean[k]; for (let i = 0; i < n; i++) o[i] -= d; }
    else for (let i = 0; i < n; i++) o[i] = -o[i];
  };
  const job = pxJob(m, c);
  const snap = { allocs: c.allocs.length, heapEnd: c.heapEnd, pkEnd: c.pkEnd, ver: c.ver };
  const segs = new Array(ch).fill(null);
  let dcN = 0;
  try {
    let done = 0;
    const share = op === "mono", work = (op === "dc" ? (b - a) * outs.length : 0) + (ref ? 0 : (i1 - i0) * (share ? 1 : outs.length)) || 1;
    if (op === "dc") {
      for (const k of outs) {
        let s = 0;
        for (let p = a; p < b; p += CH) {
          const n = Math.min(CH, b - p), o = buf.subarray(0, n);
          rd(k, p, n, o);
          for (let i = 0; i < n; i++) s += o[i];
          done += n;
          await job.tick(done / work);
        }
        mean[k] = s / (b - a);
      }
      outs = outs.filter(k => Math.abs(mean[k]) >= PX_DC_MIN);
      if (!outs.length) throw new Error("dc-none");
      for (const k of outs) if (Math.abs(mean[k]) > Math.abs(dcN)) dcN = mean[k];
      dcN = Math.round(dcN * 1e6);
    }
    const edge = (k, p, n, rising) => {
      const o = new Float32Array(n), org = new Float32Array(n);
      make(k, p, n, o, new Float32Array(n));
      rd(k, p, n, org);
      for (let i = 0; i < n; i++) { const w = rising ? (i + 0.5) / n : (n - i - 0.5) / n; o[i] = org[i] + (o[i] - org[i]) * w; }
      return [allocData(o), 0, 0, n];
    };
    let mid0 = null;
    for (const k of outs) {
      let mid = [];
      if (i1 > i0) {
        if (ref) mid = sliceList(lists[ref(k)], i0, i1);
        else if (share && mid0) mid = mid0;
        else {
          for (let p = i0; p < i1; p += CH) {
            const n = Math.min(CH, i1 - p), o = buf.subarray(0, n);
            make(k, p, n, o, tmp && tmp.subarray(0, n));
            mid.push([allocData(o), 0, 0, n]);
            done += n;
            await job.tick(done / work);
          }
          mid0 = mid;
        }
      }
      segs[k] = (h0 ? [edge(k, a, h0, true)] : []).concat(mid, h1 ? [edge(k, b - h1, h1, false)] : []);
    }
    if (cur !== c || c.lists !== lists) throw new Error("changed");
  } catch (e) {
    job.done();
    nrRollback(c, snap);
    throw e;
  }
  job.done();
  return enqueue(() => {
    if (cur !== c || c.lists !== lists) { nrRollback(c, snap); throw new Error("changed"); }
    const next = opPatch(c.lists, segs.map(s => s ? [[a, b, s]] : null));
    const before = { a: clampI(m.a, 0, c.len), b: clampI(m.b, 0, c.len), cursor: clampI(m.cursor, 0, c.len) };
    pushHist({ op, a, b, n: dcN, ch: two || chans.every(Boolean) ? null : chanLabel(chans) }, next, before, before);
    persist();
    return statePayload(m.have, { t: "state", sel: null, dc: op === "dc" ? Array.from(mean, (v, k) => outs.includes(k) ? v : null) : null });
  });
}

async function pxNewDoc(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const ch = c.meta.channels, sr = c.meta.sampleRate, F = c.len;
  const mode = ["mix", "left", "right", "stereo"].includes(m.mode) ? m.mode : "mix";
  if (mode === "stereo" ? ch !== 1 : ch < 2) throw new Error("px-stereo");
  const out = mode === "stereo" ? 2 : 1, lists = c.lists, cums = c.cum;
  const rds = (src, cc, f, n, o, off) => readSrcOf(c, src, cc, f, n, o, off);
  const rd = (k, p, n, o) => readList(lists[k], cums[k], p, n, o, 0, rds);
  const job = pxJob(m, c);
  const dir = await docsDir(), id = crypto.randomUUID(), docDir = await dir.getDirectoryHandle(id, { create: true });
  let pool = null;
  try {
    pool = await (await docDir.getFileHandle("pool.f32", { create: true })).createSyncAccessHandle();
    const S = sinkNew(pool, out, sr), N = 65536, src = new Float32Array(N * out), t = new Float32Array(N);
    for (let p = 0; p < F; p += N) {
      const n = Math.min(N, F - p), o = src.subarray(0, n * out);
      if (mode === "mix") {
        o.fill(0);
        for (let k = 0; k < ch; k++) { rd(k, p, n, t); for (let i = 0; i < n; i++) o[i] += t[i]; }
        const g = 1 / ch;
        for (let i = 0; i < n; i++) o[i] *= g;
      } else if (mode === "stereo") {
        rd(0, p, n, o);
        o.copyWithin(n, 0, n);
      } else rd(mode === "left" ? 0 : 1, p, n, o);
      sinkPush(S, o, n);
      await job.tick(Math.min(1, (p + n) / F));
    }
    const { slots, slotPeaks, bands } = sinkEnd(S);
    pool.flush();
    pool.close();
    pool = null;
    await writeFile(docDir, "peaks.f32", slotPeaks);
    await writeFile(docDir, "bands.f32", bands);
    const stem = c.meta.name.replace(/\.[^.]+$/, "") || "Untitled";
    const name = String(m.name || "").trim().slice(0, 160) || stem + " (" + (mode === "mix" ? "mono" : mode) + ")";
    const locs = c.marks.map(x => Object.assign({}, x, { chans: null }));
    const meta = { v: 1, id, name, ext: "", size: F * out * 4, sampleRate: sr, channels: out, bits: c.meta.bits, frames: F, blockFrames: BLOCK, slots, created: Date.now(), opened: Date.now(), readOnly: false, source: { kind: "derived", from: c.meta.id }, locs, tags: c.meta.tags || [] };
    if (c.meta.cover) {
      try {
        const f = await (await c.dir.getFileHandle("cover.bin")).getFile();
        await writeFile(docDir, "cover.bin", new Uint8Array(await f.arrayBuffer()));
        meta.cover = Object.assign({}, c.meta.cover);
      } catch {}
    }
    await writeFile(docDir, "meta.json", enc(meta));
    job.done();
    return { t: "made", meta };
  } catch (e) {
    job.done();
    if (pool) { try { pool.close(); } catch {} }
    try { await dir.removeEntry(id, { recursive: true }); } catch {}
    throw e;
  }
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
const TN = { job: null, feat: null };

async function tnFeatures(c, m) {
  if (TN.job) TN.job.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 };
  TN.job = job;
  const x = await dspExports(), ch = c.meta.channels, F = c.len, sr = c.meta.sampleRate, lists = c.lists, cum = c.cum;
  try {
    if (x.on_open(ch, sr) !== 0) throw new Error(dspError(x));
    const B = 65536, rd = (src, cc, f, k, out, off) => readSrcOf(c, src, cc, f, k, out, off);
    for (let s = 0; s < F; s += B) {
      const k = Math.min(B, F - s);
      const ptr = x.on_in(k, ch);
      const inb = new Float32Array(x.memory.buffer, ptr, k * ch);
      for (let ci = 0; ci < ch; ci++) readList(lists[ci], cum[ci], s, k, inb, ci * k, rd);
      if (x.on_feed(k) !== 0) throw new Error(dspError(x));
      const now = performance.now();
      if (now - job.last > 120) { job.last = now; postMessage({ t: "tnprog", id: job.id, frac: (s + k) / F }); await new Promise(r => setTimeout(r, 0)); }
      if (job.cancel || cur !== c) throw new Error("cancelled");
    }
    if (c.lists !== lists) throw new Error("stale");
    if (x.on_finish() !== 0) throw new Error(dspError(x));
    const ip = x.on_info();
    const [n, hop, blk, nf, ne] = Array.from(new Uint32Array(x.memory.buffer, ip, 5));
    const flux = new Float32Array(nf), env = new Float32Array(ne), envr = new Float32Array(ne);
    if (nf) flux.set(new Float32Array(x.memory.buffer, x.on_flux(), nf));
    if (ne) { env.set(new Float32Array(x.memory.buffer, x.on_env(), ne)); envr.set(new Float32Array(x.memory.buffer, x.on_envr(), ne)); }
    return { c, lists, cum, flux, env, envr, n, hop, blk, sr, len: F };
  } finally {
    if (TN.job === job) { TN.job = null; x.on_close(); }
  }
}

async function tnScan(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  let f = TN.feat && TN.feat.c === c && TN.feat.lists === c.lists ? TN.feat : null;
  if (!f) { TN.feat = null; f = TN.feat = await tnFeatures(c, m); }
  const ch = c.meta.channels, tmp = new Float32Array(4096), rd = (src, cc, q, k, out, off) => readSrcOf(c, src, cc, q, k, out, off);
  const read = (s0, cnt) => {
    const out = new Float32Array(cnt), buf = cnt <= tmp.length ? tmp : new Float32Array(cnt);
    for (let ci = 0; ci < ch; ci++) {
      readList(f.lists[ci], f.cum[ci], s0, cnt, buf, 0, rd);
      for (let i = 0; i < cnt; i++) out[i] += buf[i] / ch;
    }
    return out;
  };
  const r = onFind(f, read, m.level);
  return { t: "transients", id: c.meta.id, len: f.len, pos: r.pos, str: r.str };
}

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
  for (const k of ["name", "pos", "title", "artist", "album", "albumArtist", "year", "label", "catno", "country", "genre", "style", "format", "release", "cover", "isrc"]) {
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

const NL = { job: null, MAXLAG: 2, WIN: 1 << 17 };

function nlLag(x, y, M) {
  const L = x.length;
  let N = 1;
  while (N < L + y.length) N <<= 1;
  const xr = new Float64Array(N), xi = new Float64Array(N), yr = new Float64Array(N), yi = new Float64Array(N);
  xr.set(x);
  yr.set(y);
  djFft(xr, xi, false);
  djFft(yr, yi, false);
  for (let i = 0; i < N; i++) {
    const r = xr[i] * yr[i] + xi[i] * yi[i], q = xr[i] * yi[i] - xi[i] * yr[i], a = Math.hypot(r, q);
    xr[i] = a > 1e-20 ? r / a : 0;
    xi[i] = a > 1e-20 ? q / a : 0;
  }
  djFft(xr, xi, true);
  let best = 0, bv = -Infinity, s2 = 0;
  for (let j = 0; j <= 2 * M; j++) { const v = xr[j]; s2 += v * v; if (v > bv) { bv = v; best = j; } }
  const rms = Math.sqrt(s2 / (2 * M + 1));
  return { lag: best - M, score: rms > 0 && bv > 0 ? bv / rms : 0 };
}

async function nullTest(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  if (m.other === m.id) throw new Error("null-self");
  let o = lingering.get(m.other) || null, fresh = false;
  if (!o) {
    let dd, meta;
    try { dd = await (await docsDir()).getDirectoryHandle(String(m.other)); meta = await readJson(dd, "meta.json"); } catch { throw new Error("null-gone"); }
    if (meta.recording) throw new Error("recording");
    o = await loadDoc(dd, meta);
    fresh = true;
  }
  if (NL.job) NL.job.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 };
  NL.job = job;
  job.tick = async frac => {
    const now = performance.now();
    if (now - job.last > 120) { job.last = now; postMessage({ t: "lprog", id: job.id, frac: Math.min(1, frac) }); await new Promise(r => setTimeout(r, 0)); }
    if (job.cancel || cur !== c) throw new Error("cancelled");
  };
  try {
    const sr = c.meta.sampleRate, ch = c.meta.channels, F = c.len, G = o.len;
    if (o.meta.sampleRate !== sr) throw new Error("null-rate");
    if (o.meta.channels !== ch) throw new Error("null-ch");
    const a = clampI(m.a, 0, F), b = m.b > m.a ? clampI(m.b, 0, F) : F;
    if (b <= a) throw new Error("nothing");
    const lists = c.lists, olists = o.lists;
    const rdA = (k, s, n, out, off) => readList(lists[k], c.cum[k], s, n, out, off, (src, cc, f, q, ob, oo) => readSrcOf(c, src, cc, f, q, ob, oo));
    const rdB = (k, s, n, out, off) => {
      out.fill(0, off, off + n);
      const s0 = Math.max(s, 0), s1 = Math.min(s + n, G);
      if (s1 > s0) readList(olists[k], o.cum[k], s0, s1 - s0, out, off + s0 - s, (src, cc, f, q, ob, oo) => readSrcOf(o, src, cc, f, q, ob, oo));
    };
    const mono = (rd, s, n) => {
      const out = new Float32Array(n), tmp = new Float32Array(n);
      for (let k = 0; k < ch; k++) { rd(k, s, n, tmp, 0); for (let i = 0; i < n; i++) out[i] += tmp[i]; }
      return out;
    };
    let lag = 0, score = null, aligned = false;
    if (m.align) {
      const M = Math.min(Math.round(sr * NL.MAXLAG), Math.max(F, G));
      let L = 1024;
      while (L * 2 <= Math.min(b - a, NL.WIN)) L <<= 1;
      if (b - a >= 1024) {
        let w0 = a, best = -1;
        const span = b - a - L;
        for (let q = 0; q < 9; q++) {
          const s = a + Math.round(span * q / 8), x = mono(rdA, s, Math.min(L, 4096));
          let e = 0;
          for (let i = 0; i < x.length; i++) e += x[i] * x[i];
          if (e > best) { best = e; w0 = s; }
        }
        await job.tick(0.02);
        const x = mono(rdA, w0, L), y = mono(rdB, w0 - M, L + 2 * M);
        const r = nlLag(x, y, M);
        await job.tick(0.08);
        score = r.score;
        if (r.score >= 8) {
          let bl = r.lag, be = Infinity;
          for (let d = -2; d <= 2; d++) {
            let e = 0, sab = 0, sbb = 0;
            for (let i = 0; i < L; i++) { const yv = y[i + M + r.lag + d] || 0; sab += x[i] * yv; sbb += yv * yv; }
            const g = sbb > 0 ? sab / sbb : 1;
            for (let i = 0; i < L; i++) { const dv = x[i] - g * (y[i + M + r.lag + d] || 0); e += dv * dv; }
            if (e < be) { be = e; bl = r.lag + d; }
          }
          lag = bl;
          aligned = true;
        }
      }
    }
    const B = 65536, A1 = new Float32Array(B), B1 = new Float32Array(B);
    let g = 1;
    if (m.gain) {
      let sab = 0, sbb = 0;
      for (let s = a; s < b; s += B) {
        const n = Math.min(B, b - s);
        for (let k = 0; k < ch; k++) {
          rdA(k, s, n, A1, 0);
          rdB(k, s + lag, n, B1, 0);
          for (let i = 0; i < n; i++) { sab += A1[i] * B1[i]; sbb += B1[i] * B1[i]; }
        }
        await job.tick(0.1 + 0.4 * (s + n - a) / (b - a));
      }
      if (sbb > 0 && sab > 0) g = sab / sbb;
    }
    const st = Array.from({ length: ch }, () => ({ peak: 0, peakAt: -1, d2: 0, a2: 0, first: -1 }));
    const w0 = m.gain ? 0.5 : 0.1;
    const pass = async push => {
      const D = new Float32Array(B * ch);
      for (let s = a; s < b; s += B) {
        const n = Math.min(B, b - s);
        for (let k = 0; k < ch; k++) {
          rdA(k, s, n, A1, 0);
          rdB(k, s + lag, n, B1, 0);
          const q = st[k], off = k * n;
          for (let i = 0; i < n; i++) {
            const v = A1[i] - g * B1[i];
            D[off + i] = v;
            const av = v < 0 ? -v : v;
            q.d2 += v * v;
            q.a2 += A1[i] * A1[i];
            if (av > q.peak) { q.peak = av; q.peakAt = s + i; }
            if (v !== 0 && q.first < 0) q.first = s + i;
          }
        }
        if (push) push(D.subarray(0, n * ch), n);
        await job.tick(w0 + (1 - w0) * (s + n - a) / (b - a));
      }
    };
    let made = null;
    if (m.make) {
      const base = String(c.meta.name || "").replace(/\.[^.]+$/, "") + " − " + String(o.meta.name || "").replace(/\.[^.]+$/, "");
      made = (await sesNewDoc(String(m.name || base).slice(0, 150), sr, ch, b - a, pass, job, { source: { kind: "derived", from: c.meta.id } })).meta;
    } else await pass(null);
    const n = b - a, db = v => v > 0 ? 20 * Math.log10(v) : null;
    const overlap = Math.max(0, Math.min(b, G - lag) - Math.max(a, -lag));
    return { t: "nullres", a, b, sr, lag, score, aligned, gain: 20 * Math.log10(g), lenA: F, lenB: G, overlap, other: { id: o.meta.id, name: o.meta.name }, made,
      chans: st.map(q => ({ peak: db(q.peak), peakAt: q.peakAt, rms: db(Math.sqrt(q.d2 / n)), rel: q.a2 > 0 && q.d2 > 0 ? 10 * Math.log10(q.d2 / q.a2) : null, first: q.first, zero: q.d2 === 0 })) };
  } finally {
    if (NL.job === job) NL.job = null;
    if (fresh) closeHandles(o);
  }
}

async function ldReport(m) {
  const c = cur;
  if (!c || c.meta.id !== m.id) throw new Error("stale");
  const x = await dspExports(), ch = c.meta.channels, F = c.len, sr = c.meta.sampleRate;
  const a = clampI(m.a, 0, F), b = m.b > m.a ? clampI(m.b, 0, F) : F;
  if (b <= a) throw new Error("nothing");
  if (LD.rep) LD.rep.cancel = true;
  const job = { id: m.jobId, cancel: false, last: 0 }, lists = c.lists;
  LD.rep = job;
  job.tick = async frac => {
    const now = performance.now();
    if (now - job.last > 120) { job.last = now; postMessage({ t: "lprog", id: job.id, frac: Math.min(1, frac) }); await new Promise(r => setTimeout(r, 0)); }
    if (job.cancel || cur !== c) throw new Error("cancelled");
  };
  try {
    if (x.rp_open(ch, sr) !== 0) throw new Error(dspError(x));
    const rd = (src, cc, f, k, out, off) => readSrcOf(c, src, cc, f, k, out, off);
    const B = 65536;
    for (let s = a; s < b; s += B) {
      const n = Math.min(B, b - s);
      const ptr = x.rp_in(n, ch);
      const inb = new Float32Array(x.memory.buffer, ptr, n * ch);
      for (let k = 0; k < ch; k++) readList(lists[k], c.cum[k], s, n, inb, k * n, rd);
      if (x.rp_feed(n) !== 0) throw new Error(dspError(x));
      await job.tick((s + n - a) / (b - a));
    }
    if (c.lists !== lists) throw new Error("stale");
    const len = x.rp_done();
    if (len < 0) throw new Error(dspError(x));
    const op = x.rp_out();
    const v = Array.from(new Float64Array(x.memory.buffer, op, len));
    x.rp_close();
    const db = q => q > 0 ? 20 * Math.log10(q) : null;
    const fin = q => Number.isFinite(q) ? q : null;
    const nc = v[7], at = 9 + 9 * ch, chans = [];
    for (let k = 0; k < ch; k++) {
      const o = v.slice(9 + 9 * k, 18 + 9 * k);
      chans.push({ tp: db(o[0]), tpAt: o[1], sp: db(o[2]), spAt: o[3], rms: db(o[4]), dc: o[5], clips: o[6], overs: o[7], bits: o[8] });
    }
    return { t: "ldreport", a, b, sr, ch, name: c.meta.name, bits: c.meta.bits || null, integrated: fin(v[0]), lra: fin(v[1]), st: fin(v[2]), stAt: v[3], mom: fin(v[4]), momAt: v[5], secs: v[6], chans, curve: v.slice(at, at + nc).map(q => q < -150 ? null : Math.round(q * 100) / 100) };
  } finally { if (LD.rep === job) LD.rep = null; }
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
  if (m.t === "stop") { stopPlay(); if (SES.punch || SES.scn) { SES.punch = null; SES.scn = null; if (SES.s) SES.mix = sesMixer(SES.s); } return; }
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
  if (m.t === "ldmeasure" || m.t === "ldref" || m.t === "ldfit" || m.t === "ldreport") {
    const f = { ldmeasure: ldMeasure, ldref: ldRef, ldfit: ldFit, ldreport: ldReport }[m.t];
    try { postMessage(Object.assign({ req: m.req }, await f(m))); }
    catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); }
    return;
  }
  if (m.t === "ldcancel") { if (LD.job) LD.job.cancel = true; return; }
  if (m.t === "repcancel") { if (LD.rep) LD.rep.cancel = true; return; }
  if (m.t === "nulltest") {
    try { postMessage(Object.assign({ req: m.req }, await nullTest(m))); }
    catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); }
    return;
  }
  if (m.t === "nullcancel") { if (NL.job) NL.job.cancel = true; return; }
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
  if (m.t === "tnscan") {
    try { postMessage(Object.assign({ req: m.req }, await tnScan(m))); }
    catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); }
    return;
  }
  if (m.t === "tncancel") { if (TN.job) TN.job.cancel = true; return; }
  if (m.t === "mdlisten") { MDL.mode = ["midi", "both"].includes(m.mode) ? m.mode : "off"; MDL.notes = MDL.mode === "off" ? [] : mdClean(m.notes); ringFlush(); return; }
  if (m.t === "rkmeter") { postMessage(Object.assign({ req: m.req }, m.ses ? sesRackMeter(String(m.ses)) : rkMeter())); return; }
  if (m.t === "fxapply") { postMessage(Object.assign({ req: m.req }, await fxApply(m))); return; }
  if (m.t === "proc") { postMessage(Object.assign({ req: m.req }, await pxApply(m))); return; }
  if (m.t === "seslist") { postMessage(Object.assign({ req: m.req }, await sesList())); return; }
  if (m.t === "sesnew") { postMessage(Object.assign({ req: m.req }, await sesNew(m))); return; }
  if (m.t === "sesopen") { postMessage(Object.assign({ req: m.req }, await enqueue(() => sesOpen(m)))); return; }
  if (m.t === "sesdoc") { postMessage(Object.assign({ req: m.req }, await enqueue(async () => ({ t: "sesdoc", doc: await sesPayload(String(m.id)) })))); return; }
  if (m.t === "sesput") { postMessage(Object.assign({ req: m.req }, await sesPut(m))); return; }
  if (m.t === "sesmix") { sesSetMix(m); return; }
  if (m.t === "sesplay") { sesStartPlay(m); return; }
  if (m.t === "sclaunch") { scLaunch(m); return; }
  if (m.t === "sclufs") { try { postMessage(Object.assign({ req: m.req }, await enqueue(() => scLufs(m)))); } catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); } return; }
  if (m.t === "scread") { try { const r = scRead(m); postMessage(Object.assign({ req: m.req }, r), [r.data.buffer]); } catch (e) { postMessage({ t: "error", req: m.req, msg: errText(e) }); } return; }
  if (m.t === "sesclose") { postMessage(Object.assign({ req: m.req }, await enqueue(async () => sesClose()))); return; }
  if (m.t === "sesdel") { postMessage(Object.assign({ req: m.req }, await sesDel(m))); return; }
  if (m.t === "sesbounce") { postMessage(Object.assign({ req: m.req }, await sesBounce(m))); return; }
  if (m.t === "sesconv") { postMessage(Object.assign({ req: m.req }, await sesConvert(m))); return; }
  if (m.t === "sescancel") { if (SES.job) SES.job.cancel = true; return; }
  if (m.t === "djprobe") { postMessage(Object.assign({ req: m.req }, await djProbe(m))); return; }
  if (m.t === "djimport") { postMessage(Object.assign({ req: m.req }, await djImport(m))); return; }
  if (m.t === "docinfo") { postMessage(Object.assign({ req: m.req }, await enqueue(() => docInfo(m)))); return; }
  if (m.t === "albums") { postMessage(Object.assign({ req: m.req }, await albumsGet())); return; }
  if (m.t === "albumsput") { postMessage(Object.assign({ req: m.req }, await enqueue(() => albumsPut(m)))); return; }
  if (m.t === "tagsget") { postMessage(Object.assign({ req: m.req }, await tagsGet(m))); return; }
  if (m.t === "tagsset") { postMessage(Object.assign({ req: m.req }, await enqueue(() => tagsSet(m)))); return; }
  if (m.t === "pxnew") { postMessage(Object.assign({ req: m.req }, await pxNewDoc(m))); return; }
  if (m.t === "pxcancel") { if (PX.job) PX.job.cancel = true; return; }
  if (m.t === "fxcancel") { if (FX.job) FX.job.cancel = true; return; }
  if (m.t === "adjust") { postMessage(Object.assign({ req: m.req }, await enqueue(() => adjustSel(m)))); return; }
  if (m.t === "flush") { await enqueue(async () => { if (cur && cur.saving) await cur.saving; }); postMessage({ t: "flushed", req: m.req, err: cur ? cur.saveErr : null }); return; }
}

onmessage = e => {
  const m = e.data;
  handle(m).catch(err => postMessage({ t: "error", req: m.req, msg: errText(err) }));
};

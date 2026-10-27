const BUCKET = 256;
const BPB = 256;
const RING = 1 << 17;
const DB_RANGE = 60;
const AUDIO_ACCEPT = ".flac,.wav,.wave,.bwf,.aif,.aiff,.aifc,.mp3,.mp2,.m4a,.mp4,.aac,.alac,.caf,.ogg,.oga";

const ed = {
  worker: new Worker("/worker.js"),
  req: 0,
  pending: new Map(),
  doc: null,
  srcs: [],
  clip: null,
  ver: 0,
  hist: [],
  histIdx: 0,
  clipInfo: null,
  editing: false,
  xfade: localStorage.getItem("studioXfade") === null ? 5 : Number(localStorage.getItem("studioXfade")) || 0,
  snap: localStorage.getItem("studioSnap") === "1",
  view: { start: 0, spp: 1 },
  sel: { a: 0, b: 0 },
  chans: [],
  cursor: 0,
  scale: localStorage.getItem("studioScale") || "lin",
  colour: localStorage.getItem("studioColour") || "spectral",
  fmt: localStorage.getItem("studioFmt") || "time",
  loop: false,
  raw: null,
  rawWant: null,
  rawBusy: false,
  play: { on: false, start: 0, end: 0, loop: false, t0: 0 },
  ctx: null,
  node: null,
  ring: null,
  meter: { pk: [], rms: [], hold: [], holdT: [], clip: [], t: 0 },
  dirty: false,
  dragging: null,
  importing: null,
  libSeq: 0,
  docs: [],
  locker: null,
  account: null,
  tab: "studio"
};

const $ = id => document.getElementById(id);

function call(msg, transfer) {
  const req = ++ed.req;
  msg.req = req;
  return new Promise((resolve, reject) => {
    ed.pending.set(req, { resolve, reject });
    ed.worker.postMessage(msg, transfer || []);
  });
}

ed.worker.onmessage = e => {
  const m = e.data;
  if (m.t === "progress") { importProgress(m); return; }
  if (m.t === "playerror") { stopPlay(); tell(t("Playback stopped") + ": " + m.msg); return; }
  if (m.t === "xjob") { xpJob(m); return; }
  if (m.t === "dprog") { dgProg(m); return; }
  if (m.t === "nprog") { nrProg(m); humProg(m); ldProg(m); fxProg(m); return; }
  if (m.t === "lprog") { if (!repProg(m) && !nlProg(m)) ldProg(m); return; }
  if (m.t === "mprog") { mdProg(m); return; }
  if (m.t === "tprog") { trProg(m); return; }
  if (m.t === "pprog") { pxProg(m); return; }
  if (m.t === "tnprog") { tnProg(m); return; }
  if (m.t === "sprog") { ssProg(m); return; }
  if (m.t === "aprog") { nrAutoProg(m); return; }
  if (m.t === "spectile") { spTile(m); return; }
  if (m.t === "specerr") { spErr(m); return; }
  const p = ed.pending.get(m.req);
  if (!p) return;
  ed.pending.delete(m.req);
  if (m.t === "error") p.reject(Object.assign(new Error(m.msg), { name: m.name || "" })); else p.resolve(m);
};

function fmtBytes(n) {
  if (n >= 1e9) return (n / 1e9).toFixed(n >= 1e10 ? 0 : 1) + " GB";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e8 ? 0 : 1) + " MB";
  return Math.max(1, Math.round(n / 1e3)) + " kB";
}

function fmtDur(sec) {
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  return (h ? h + ":" + String(m).padStart(2, "0") : m) + ":" + String(s).padStart(2, "0");
}

function fmtTime(frames, fmt, step) {
  const sr = ed.doc ? ed.doc.sampleRate : ses.open ? ssRate() : 48000;
  fmt = fmt || ed.fmt;
  if (fmt === "samples") return String(Math.round(frames));
  const neg = frames < 0 ? "-" : "";
  const sec = Math.abs(frames) / sr;
  if (fmt === "cd") {
    const total = Math.floor(sec * 75 + 1e-9);
    const m = Math.floor(total / 4500), s = Math.floor(total / 75) % 60, f = total % 75;
    return neg + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0") + ":" + String(f).padStart(2, "0");
  }
  const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60);
  let s = sec % 60;
  let dec = 3;
  if (step !== undefined) dec = step >= 1 ? 0 : step >= 0.1 ? 1 : step >= 0.01 ? 2 : 3;
  let ss = s.toFixed(dec);
  if (parseFloat(ss) >= 60) ss = (0).toFixed(dec);
  ss = ss.padStart(dec ? dec + 3 : 2, "0");
  return neg + (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + ss;
}

function parseTime(text, fmt) {
  const sr = ed.doc.sampleRate;
  const s = String(text).trim().replace(/[\s_]/g, "").replace(",", ".");
  if (!s) return null;
  if (fmt === "samples") { const v = Number(s); return Number.isFinite(v) ? Math.round(v) : null; }
  const parts = s.split(":");
  if (fmt === "cd") {
    if (parts.length !== 3) return null;
    const [m, sec, f] = parts.map(Number);
    if (![m, sec, f].every(Number.isFinite)) return null;
    return Math.round((m * 60 + sec + f / 75) * sr);
  }
  let total = 0;
  for (const p of parts) { const v = Number(p); if (!Number.isFinite(v)) return null; total = total * 60 + v; }
  return Math.round(total * sr);
}

function buildPyr(n0, mins, maxs, band) {
  const ch = mins.length;
  const levels = [{ size: BUCKET, n: n0, min: mins, max: maxs, band }];
  while (levels[levels.length - 1].n > 1 && levels.length < 8) {
    const p = levels[levels.length - 1], n = Math.ceil(p.n / 16);
    const L = { size: p.size * 16, n, min: [], max: [], band: new Float32Array(n * 3) };
    for (let c = 0; c < ch; c++) {
      const mn = new Float32Array(n), mx = new Float32Array(n), pmn = p.min[c], pmx = p.max[c];
      for (let k = 0; k < n; k++) {
        let a = Infinity, b = -Infinity;
        const e = Math.min(p.n, k * 16 + 16);
        for (let j = k * 16; j < e; j++) { if (pmn[j] < a) a = pmn[j]; if (pmx[j] > b) b = pmx[j]; }
        mn[k] = a; mx[k] = b;
      }
      L.min.push(mn); L.max.push(mx);
    }
    for (let k = 0; k < n; k++) {
      const e = Math.min(p.n, k * 16 + 16), cnt = e - k * 16;
      for (let b = 0; b < 3; b++) {
        let s = 0;
        for (let j = k * 16; j < e; j++) s += p.band[j * 3 + b];
        L.band[k * 3 + b] = s / cnt;
      }
    }
    levels.push(L);
  }
  return levels;
}

function poolPyr(meta, pk, bands) {
  const ch = meta.channels, n0 = Math.ceil(meta.frames / BUCKET), buckets = meta.slots * BPB;
  const min = [], max = [];
  for (let c = 0; c < ch; c++) {
    const mn = new Float32Array(n0), mx = new Float32Array(n0);
    const base = c * buckets * 2;
    for (let k = 0; k < n0; k++) { mn[k] = pk[base + k * 2]; mx[k] = pk[base + k * 2 + 1]; }
    min.push(mn); max.push(mx);
  }
  return buildPyr(n0, min, max, bands.slice(0, n0 * 3));
}

function allocPyr(a) {
  const n0 = a.pk.length / 2, mn = new Float32Array(n0), mx = new Float32Array(n0);
  for (let k = 0; k < n0; k++) { mn[k] = a.pk[k * 2]; mx[k] = a.pk[k * 2 + 1]; }
  return buildPyr(n0, [mn], [mx], a.bd);
}

function accNew() { return { mn: Infinity, mx: -Infinity, l: 0, m: 0, h: 0 }; }
function accReset(A) { A.mn = Infinity; A.mx = -Infinity; A.l = 0; A.m = 0; A.h = 0; }

function takeRange(P, c, i0, i1, A) {
  const mn = P.min[c], mx = P.max[c], bd = P.band, w = P.size;
  for (let i = i0; i < i1; i++) {
    if (mn[i] < A.mn) A.mn = mn[i];
    if (mx[i] > A.mx) A.mx = mx[i];
    A.l += bd[i * 3] * w; A.m += bd[i * 3 + 1] * w; A.h += bd[i * 3 + 2] * w;
  }
}

function pyrQuery(lv, c, i0, i1, A) {
  let L = 0;
  while (i0 < i1) {
    const P = lv[L];
    if (L + 1 < lv.length && i1 - i0 >= 32) {
      const a0 = (i0 + 15) & ~15, b0 = i1 & ~15;
      takeRange(P, c, i0, a0, A);
      takeRange(P, c, b0, i1, A);
      i0 = a0 >> 4; i1 = b0 >> 4; L++;
      continue;
    }
    takeRange(P, c, i0, i1, A);
    break;
  }
}

function colPeak(c, s0, s1, A) { return colPeakOf(ed, c, s0, s1, A); }

function colPeakOf(M, c, s0, s1, A) {
  const C = M.clip, list = C.lists[c], cum = C.cum[c], E = C.edges[c];
  let lo = 0, hi = list.length - 1, i = 0;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (cum[mid] <= s0) { i = mid; lo = mid + 1; } else hi = mid - 1; }
  let any = false;
  for (; i < list.length && cum[i] < s1; i++) {
    const g = list[i], T0 = cum[i], n = g[3];
    const u0 = Math.max(s0, T0), u1 = Math.min(s1, T0 + n);
    if (u1 <= u0) continue;
    any = true;
    if (g[0] === SIL) { if (A.mn > 0) A.mn = 0; if (A.mx < 0) A.mx = 0; continue; }
    const S = M.srcs[g[0]];
    if (!S) continue;
    const st = g[2], end = st + n, a = st + (u0 - T0), b = st + (u1 - T0), e = E[i];
    const h1 = Math.min(end, Math.ceil(st / BUCKET) * BUCKET), t0 = Math.max(h1, Math.floor(end / BUCKET) * BUCKET);
    if (e && a < h1) { if (e[0] < A.mn) A.mn = e[0]; if (e[1] > A.mx) A.mx = e[1]; }
    if (e && b > t0 && end > t0) { if (e[2] < A.mn) A.mn = e[2]; if (e[3] > A.mx) A.mx = e[3]; }
    let full = false;
    if (t0 > h1) {
      const i0 = Math.max(h1 / BUCKET, Math.floor(a / BUCKET)), i1 = Math.min(t0 / BUCKET, Math.ceil(b / BUCKET));
      if (i1 > i0) { pyrQuery(S.levels, g[1], i0, i1, A); full = true; }
    }
    if (!full) {
      const L0 = S.levels[0], k = Math.min(L0.n - 1, Math.floor(a / BUCKET));
      A.l += L0.band[k * 3] || 0; A.m += L0.band[k * 3 + 1] || 0; A.h += L0.band[k * 3 + 2] || 0;
    }
  }
  return any;
}

function amp(v) {
  if (ed.scale !== "db") return v;
  const a = Math.abs(v);
  if (a < 1e-9) return 0;
  const n = 1 + 20 * Math.log10(a) / DB_RANGE;
  return n <= 0 ? 0 : (v < 0 ? -n : n);
}

function colourOf(l, m, h) {
  if (ed.colour !== "spectral") return TH.plain;
  const w0 = l, w1 = m * 1.4, w2 = h * 2.6, s = w0 + w1 + w2;
  if (!(s > 1e-9)) return TH.plain;
  const r = (TH.wave[0][0] * w0 + TH.wave[1][0] * w1 + TH.wave[2][0] * w2) / s;
  const g = (TH.wave[0][1] * w0 + TH.wave[1][1] * w1 + TH.wave[2][1] * w2) / s;
  const b = (TH.wave[0][2] * w0 + TH.wave[1][2] * w1 + TH.wave[2][2] * w2) / s;
  return "rgb(" + (r | 0) + "," + (g | 0) + "," + (b | 0) + ")";
}

function canvasFit(cv) {
  const dpr = window.devicePixelRatio || 1;
  const w = Math.max(1, Math.round(cv.clientWidth * dpr)), h = Math.max(1, Math.round(cv.clientHeight * dpr));
  if (cv.width !== w || cv.height !== h) { cv.width = w; cv.height = h; }
  return dpr;
}

function viewWidth() { return $("wv").clientWidth || 1; }

function clampView() {
  if (!ed.doc) return;
  const W = viewWidth(), F = ed.doc.frames;
  const maxSpp = Math.max(F / W, 1 / 32);
  ed.view.spp = Math.min(Math.max(ed.view.spp, 1 / 32), maxSpp);
  ed.view.start = Math.min(Math.max(ed.view.start, 0), Math.max(0, F - W * ed.view.spp));
}

function frameAt(cssX) { return ed.view.start + cssX * ed.view.spp; }
function xOf(frame) { return (frame - ed.view.start) / ed.view.spp; }

function zoomAt(factor, anchorFrame) {
  if (!ed.doc) return;
  const W = viewWidth();
  if (anchorFrame === undefined) {
    const c = ed.play.on ? playhead() : ed.cursor;
    anchorFrame = c >= ed.view.start && c <= ed.view.start + W * ed.view.spp ? c : ed.view.start + W * ed.view.spp / 2;
  }
  const ax = xOf(anchorFrame);
  ed.view.spp *= factor;
  clampView();
  ed.view.start = anchorFrame - ax * ed.view.spp;
  clampView();
  redraw();
}

function zoomFit() {
  if (!ed.doc) return;
  ed.view.spp = ed.doc.frames / viewWidth();
  ed.view.start = 0;
  clampView();
  redraw();
}

function zoomSel() {
  if (!ed.doc || ed.sel.b <= ed.sel.a) return;
  const len = ed.sel.b - ed.sel.a, W = viewWidth();
  ed.view.spp = len * 1.1 / W;
  clampView();
  ed.view.start = ed.sel.a - len * 0.05;
  clampView();
  redraw();
}

function ensureVisible(frame) {
  const W = viewWidth(), vis = W * ed.view.spp;
  if (frame < ed.view.start || frame > ed.view.start + vis) { ed.view.start = frame - vis * 0.25; clampView(); }
}

function redraw() {
  if (ed.dirty) return;
  ed.dirty = true;
  requestAnimationFrame(() => { ed.dirty = false; render(); });
}

function render() {
  if (!ed.doc) return;
  spLayout();
  drawOverview();
  drawRuler();
  if (!$("wv").classList.contains("gone")) drawWave();
  drawSpec();
  updatePanel();
  saveView();
}

function rawCovers(a, b) {
  const r = ed.raw;
  return r && r.id === ed.doc.id && r.ver === ed.ver && a >= r.start && b <= r.start + r.count;
}

function wantRaw(a, b) {
  const span = b - a;
  const start = Math.max(0, Math.floor(a - span * 0.5)), end = Math.min(ed.doc.frames, Math.ceil(b + span * 0.5));
  ed.rawWant = { id: ed.doc.id, ver: ed.ver, start, count: end - start };
  pumpRaw();
}

async function pumpRaw() {
  if (ed.rawBusy || !ed.rawWant) return;
  const w = ed.rawWant;
  ed.rawWant = null;
  ed.rawBusy = true;
  try {
    const r = await call({ t: "read", id: w.id, start: w.start, count: w.count });
    if (ed.doc && r.id === ed.doc.id && r.ver === ed.ver && r.count) {
      ed.raw = { id: r.id, ver: r.ver, start: r.start, count: r.count, data: r.data };
      redraw();
    }
  } catch {}
  ed.rawBusy = false;
  if (ed.rawWant) pumpRaw();
}

function drawWave() {
  const cv = $("wv"), dpr = canvasFit(cv), g = cv.getContext("2d");
  const key = [THS.rev, cv.width, cv.height, ed.view.start, ed.view.spp, ed.sel.a, ed.sel.b, ed.cursor, ed.scale, ed.colour, ed.chans.join(), ed.raw ? ed.raw.id + ed.raw.ver + ":" + ed.raw.start + ":" + ed.raw.count : "", ed.doc.id, ed.ver, pxKey(), penKey(), tnDrawKey()].join("|");
  if (!ed.waveBuf) ed.waveBuf = document.createElement("canvas");
  if (key !== ed.waveKey) {
    ed.waveBuf.width = cv.width;
    ed.waveBuf.height = cv.height;
    drawWaveBase(ed.waveBuf.getContext("2d"), cv.width, cv.height, dpr);
    ed.waveKey = key;
  }
  g.drawImage(ed.waveBuf, 0, 0);
  drawDiag(g, cv.width, cv.height, dpr);
  drawFade(g, cv.width, cv.height, dpr);
  if (ed.play.on) {
    const px = Math.round(xOf(playhead()) * dpr);
    if (px >= 0 && px <= cv.width) { g.fillStyle = TH.ink; g.fillRect(px, 0, Math.max(1, dpr), cv.height); }
  }
}

function drawWaveBase(g, W, H, dpr) {
  const doc = ed.doc, ch = doc.channels;
  const laneH = H / ch, sppD = ed.view.spp / dpr, start = ed.view.start, fz = px.fade ? pxGain : null;
  g.fillStyle = TH.canvas;
  g.fillRect(0, 0, W, H);
  const selOn = ed.sel.b > ed.sel.a;
  const sx0 = Math.max(0, Math.floor(xOf(ed.sel.a) * dpr)), sx1 = Math.min(W, Math.ceil(xOf(ed.sel.b) * dpr));
  for (let c = 0; c < ch; c++) {
    const top = c * laneH, mid = top + laneH / 2, A = laneH / 2 - 3 * dpr;
    g.fillStyle = c % 2 ? TH.laneA : TH.laneB;
    g.fillRect(0, top, W, laneH);
    if (selOn && ed.chans[c]) { g.fillStyle = tw(0.09); g.fillRect(sx0, top, Math.max(1, sx1 - sx0), laneH); }
    g.fillStyle = tw(0.07);
    for (const lv of [0.5, -0.5]) { const y = mid - amp(lv) * A; g.fillRect(0, Math.round(y), W, 1); }
    g.fillStyle = tw(0.16);
    g.fillRect(0, Math.round(mid), W, 1);
    const visA = start, visB = start + W * sppD, r0 = Math.floor(visA), r1 = Math.min(doc.frames, Math.ceil(visB));
    const useRaw = sppD < BUCKET;
    if (useRaw && !rawCovers(r0, r1)) wantRaw(visA, visB);
    const raw = useRaw ? (rawCovers(r0, r1) ? ed.raw : penRaw(r0, r1)) : null, po = penOver(c);
    if (raw && sppD < 1) {
      const d = raw.data, base = c * raw.count;
      const i0 = Math.max(0, Math.floor(visA) - 1), i1 = Math.min(doc.frames - 1, Math.ceil(visB) + 1);
      const ac = accNew();
      colPeak(c, i0, i1 + 1, ac);
      g.strokeStyle = colourOf(ac.l, ac.m, ac.h);
      g.lineWidth = Math.max(1, dpr * 1.2);
      g.beginPath();
      for (let i = i0; i <= i1; i++) {
        const v = penVal(po, i, d[base + i - raw.start]), x = (i - start) / sppD, y = mid - amp(fz ? v * fz(i) : v) * A;
        if (i === i0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      if (1 / sppD >= 6) {
        g.fillStyle = g.strokeStyle;
        for (let i = i0; i <= i1; i++) {
          const v = penVal(po, i, d[base + i - raw.start]), x = (i - start) / sppD, y = mid - amp(fz ? v * fz(i) : v) * A;
          g.fillRect(x - 1.5 * dpr, y - 1.5 * dpr, 3 * dpr, 3 * dpr);
        }
      }
      continue;
    }
    const ac = accNew();
    for (let x = 0; x < W; x++) {
      const s0 = start + x * sppD, s1 = s0 + sppD;
      if (s0 >= doc.frames) break;
      let mn, mx;
      accReset(ac);
      if (raw) {
        const d = raw.data, base = c * raw.count;
        const a = Math.max(raw.start, Math.floor(s0)), b = Math.min(raw.start + raw.count, Math.max(a + 1, Math.ceil(s1)));
        mn = Infinity; mx = -Infinity;
        for (let i = a; i < b; i++) { const v = penVal(po, i, d[base + i - raw.start]); if (v < mn) mn = v; if (v > mx) mx = v; }
        colPeak(c, a, b, ac);
      } else {
        if (!colPeak(c, s0, s1, ac) || ac.mx === -Infinity) continue;
        mn = ac.mn; mx = ac.mx;
      }
      if (fz) { const k = fz(s0 + sppD / 2); mn *= k; mx *= k; }
      const col = colourOf(ac.l, ac.m, ac.h);
      let y0 = mid - amp(mx) * A, y1 = mid - amp(mn) * A;
      if (y1 - y0 < 1) { const ym = (y0 + y1) / 2; y0 = ym - 0.5; y1 = ym + 0.5; }
      g.fillStyle = col;
      g.fillRect(x, y0, 1, y1 - y0);
    }
  }
  g.fillStyle = tw(0.12);
  for (let c = 1; c < ch; c++) g.fillRect(0, Math.round(c * laneH), W, 1);
  drawAmpLabels(g, W, laneH, ch, dpr);
  g.fillStyle = tc("blue", 0.6);
  for (const m of shownMarks()) {
    for (const f of m.kind === "range" ? [m.a, m.b] : [m.a]) {
      const x = Math.round(xOf(f) * dpr);
      if (x < 0 || x > W) continue;
      for (let y = 0; y < H; y += 7 * dpr) g.fillRect(x, y, Math.max(1, dpr), 4 * dpr);
    }
  }
  tnDraw(g, W, H, dpr);
  const cx = Math.round(xOf(ed.cursor) * dpr);
  if (cx >= 0 && cx <= W) { g.fillStyle = TH.gold; g.fillRect(cx, 0, Math.max(1, dpr), H); }
}

function drawAmpLabels(g, W, laneH, ch, dpr) {
  g.font = thFont(9, dpr);
  g.textAlign = "right";
  g.textBaseline = "middle";
  const marks = ed.scale === "db" ? [0, -6, -12, -24, -48] : [0, -6, -12, -18];
  for (let c = 0; c < ch; c++) {
    const top = c * laneH, mid = top + laneH / 2, A = laneH / 2 - 3 * dpr;
    const k = dpr * thFs();
    let last = -Infinity;
    for (const db of marks) {
      const v = Math.pow(10, db / 20), y = mid - amp(v) * A;
      if (y < top + 6 * dpr) continue;
      if (y - last < 10 * k + dpr) continue;
      last = y;
      g.fillStyle = tc("shade", 0.7);
      g.fillRect(W - 30 * k, y - 5 * k, 30 * k, 10 * k);
      g.fillStyle = TH.label;
      g.fillText(db === 0 ? "0" : String(db), W - 4 * dpr, y);
    }
    if (ch > 1) {
      g.textAlign = "left";
      g.fillStyle = ed.chans[c] ? TH.text : TH.faint;
      g.fillText(chanName(c, ch), (c ? 6 : pxLabelX()) * dpr, top + 9 * k);
      g.textAlign = "right";
    }
  }
}

function chanName(c, ch) {
  if (ch === 2) return c === 0 ? "L" : "R";
  return String(c + 1);
}

function tickStep(sppCss) { return tickStepFor(sppCss, ed.doc.sampleRate); }

function tickStepFor(sppCss, sr) {
  const minPx = 90;
  if (ed.fmt === "samples") {
    const raw = sppCss * minPx;
    const p = Math.pow(10, Math.floor(Math.log10(Math.max(1, raw))));
    for (const m of [1, 2, 5, 10]) if (p * m >= raw) return { major: p * m, minor: p * m / (m === 2 ? 4 : 5) };
  }
  const secPerPx = sppCss / sr, want = secPerPx * minPx;
  const steps = ed.fmt === "cd" ? [1 / 75, 2 / 75, 5 / 75, 15 / 75, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600] : [0.001, 0.002, 0.005, 0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600];
  let major = steps[steps.length - 1];
  for (const s of steps) if (s >= want) { major = s; break; }
  const div = major >= 60 && major % 60 === 0 ? 4 : (String(major).includes("2") ? 4 : 5);
  return { major: major * sr, minor: major * sr / div, sec: major };
}

const MARK_LANE = 12;

function drawRuler() {
  const cv = $("ru"), dpr = canvasFit(cv), g = cv.getContext("2d");
  const k = dpr * thFs(), W = cv.width, H = cv.height, T = H - MARK_LANE * k;
  g.fillStyle = TH.panel;
  g.fillRect(0, 0, W, H);
  g.fillStyle = TH.canvas;
  g.fillRect(0, T, W, H - T);
  if (ed.sel.b > ed.sel.a) {
    const a = xOf(ed.sel.a) * dpr, b = xOf(ed.sel.b) * dpr;
    g.fillStyle = tc("gold", 0.22);
    g.fillRect(a, 0, Math.max(1, b - a), T);
  }
  const st = tickStep(ed.view.spp);
  const startF = ed.view.start, endF = startF + cv.clientWidth * ed.view.spp;
  g.fillStyle = TH.tick;
  for (let f = Math.ceil(startF / st.minor) * st.minor; f <= endF; f += st.minor) g.fillRect(Math.round(xOf(f) * dpr), T - 5 * k, Math.max(1, dpr), 5 * k);
  g.font = thFont(9.5, dpr);
  g.textBaseline = "top";
  g.textAlign = "left";
  for (let f = Math.ceil(startF / st.major) * st.major; f <= endF; f += st.major) {
    const x = Math.round(xOf(f) * dpr);
    g.fillStyle = TH.label2;
    g.fillRect(x, T - 10 * k, Math.max(1, dpr), 10 * k);
    g.fillStyle = TH.muted;
    g.fillText(fmtTime(f, ed.fmt, st.sec), x + 3 * k, 3 * k);
  }
  g.fillStyle = TH.line;
  g.fillRect(0, T - dpr, W, dpr);
  g.fillRect(0, H - dpr, W, dpr);
  drawMarkLane(g, W, T, H, dpr);
  const cx = xOf(ed.cursor) * dpr;
  g.fillStyle = TH.gold;
  g.beginPath(); g.moveTo(cx - 5 * k, 0); g.lineTo(cx + 5 * k, 0); g.lineTo(cx, 7 * k); g.fill();
}

function shownMarks() {
  const d = ed.markDrag;
  return (ed.marks || []).filter(m => m.kind !== "view").map(m => d && d.id === m.id ? Object.assign({}, m, { a: d.a, b: d.b }) : m);
}

function markBoxes(g, dpr) {
  g.font = thFont(8.5, dpr);
  return shownMarks().map(m => {
    const x = xOf(m.a) * dpr, w = g.measureText(String(m.n)).width + 6 * dpr * thFs();
    return { m, x, w, x2: m.kind === "range" ? xOf(m.b) * dpr : x };
  });
}

function drawMarkLane(g, W, T, H, dpr) {
  const sel = ed.markSel;
  for (const bx of markBoxes(g, dpr)) {
    const { m, x, w, x2 } = bx, on = sel === m.id;
    if (x2 < 0 || x > W + w) continue;
    if (m.kind === "range") {
      g.fillStyle = on ? tc("blue", 0.45) : tc("blue", 0.22);
      g.fillRect(x, T + 3 * dpr, Math.max(dpr, x2 - x), H - T - 6 * dpr);
      g.fillStyle = TH.blue;
      g.fillRect(Math.round(x2), T, Math.max(1, dpr), H - T);
    }
    g.fillStyle = on ? TH.ink : TH.blue;
    g.fillRect(Math.round(x), T, Math.max(1, dpr), H - T);
    g.fillRect(Math.round(x), T + 1 * dpr, w, H - T - 2 * dpr);
    g.fillStyle = TH.dark;
    g.textBaseline = "middle";
    g.textAlign = "left";
    g.fillText(String(m.n), x + 3 * dpr, T + (H - T) / 2 + 0.5 * dpr);
  }
}

function markAt(cssX, cssY) {
  const cv = $("ru"), Hc = cv.clientHeight;
  if (cssY < Hc - MARK_LANE * thFs() - 2) return null;
  const g = cv.getContext("2d"), boxes = markBoxes(g, 1).reverse();
  for (const b of boxes) if (cssX >= b.x - 4 && cssX <= b.x + b.w) return { m: b.m, part: "a", grab: cssX - b.x };
  for (const b of boxes) if (b.m.kind === "range" && Math.abs(cssX - b.x2) <= 5) return { m: b.m, part: "b", grab: 0 };
  for (const b of boxes) if (b.m.kind === "range" && cssX > b.x && cssX < b.x2) return { m: b.m, part: "move", grab: cssX - b.x };
  return null;
}

function drawOverview() {
  const cv = $("ov"), dpr = canvasFit(cv), g = cv.getContext("2d");
  const key = [THS.rev, cv.width, cv.height, ed.view.start, ed.view.spp, ed.sel.a, ed.sel.b, ed.cursor, ed.scale, ed.colour, ed.doc.id, ed.ver].join("|");
  if (!ed.ovBuf) ed.ovBuf = document.createElement("canvas");
  if (key !== ed.ovKey) {
    ed.ovBuf.width = cv.width;
    ed.ovBuf.height = cv.height;
    drawOverviewBase(ed.ovBuf.getContext("2d"), cv.width, cv.height, dpr);
    ed.ovKey = key;
  }
  g.drawImage(ed.ovBuf, 0, 0);
  if (ed.play.on) { g.fillStyle = TH.ink; g.fillRect(Math.round(playhead() / (ed.doc.frames / cv.width)), 0, dpr, cv.height); }
}

function drawOverviewBase(g, W, H, dpr) {
  const doc = ed.doc, ch = doc.channels;
  g.fillStyle = TH.canvas;
  g.fillRect(0, 0, W, H);
  const sppD = doc.frames / W, mid = H / 2, A = H / 2 - 2 * dpr, ac = accNew();
  for (let x = 0; x < W; x++) {
    const s0 = x * sppD, s1 = s0 + sppD;
    accReset(ac);
    for (let c = 0; c < ch; c++) colPeak(c, s0, s1, ac);
    if (ac.mx === -Infinity) continue;
    const mn = ac.mn, mx = ac.mx;
    g.fillStyle = colourOf(ac.l, ac.m, ac.h);
    g.globalAlpha = 0.75;
    const y0 = mid - Math.abs(amp(mx)) * A, y1 = mid + Math.abs(amp(mn)) * A;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  g.globalAlpha = 1;
  const vx = ed.view.start / sppD, vw = Math.max(2 * dpr, viewWidth() * ed.view.spp / sppD);
  g.fillStyle = tw(0.1);
  g.fillRect(vx, 0, vw, H);
  g.strokeStyle = tc("ink", 0.55);
  g.lineWidth = dpr;
  g.strokeRect(vx + dpr / 2, dpr / 2, vw - dpr, H - dpr);
  if (ed.sel.b > ed.sel.a) { g.fillStyle = tc("gold", 0.25); g.fillRect(ed.sel.a / sppD, 0, Math.max(dpr, (ed.sel.b - ed.sel.a) / sppD), H); }
  g.fillStyle = TH.blue;
  for (const m of shownMarks()) { g.fillRect(Math.round(m.a / sppD), 0, dpr, 6 * dpr); if (m.kind === "range") g.fillRect(Math.round(m.b / sppD), 0, dpr, 6 * dpr); }
  g.fillStyle = TH.gold;
  g.fillRect(Math.round(ed.cursor / sppD), 0, dpr, H);
}

function updatePanel() {
  const doc = ed.doc;
  const a = ed.sel.b > ed.sel.a ? ed.sel.a : ed.cursor, b = ed.sel.b > ed.sel.a ? ed.sel.b : ed.cursor;
  for (const [id, v] of [["selStart", a], ["selEnd", b], ["selDur", b - a]]) {
    const el = $(id);
    if (document.activeElement !== el) el.value = fmtTime(v);
  }
  $("tnow").textContent = fmtTime(ed.play.on ? playhead() : ed.cursor, ed.fmt === "samples" ? "samples" : ed.fmt === "cd" ? "cd" : "time");
  $("tlen").textContent = "/ " + fmtTime(doc.frames, ed.fmt === "samples" ? "samples" : ed.fmt === "cd" ? "cd" : "time");
  $("playBtn").classList.toggle("on", ed.play.on);
  $("loopBtn").classList.toggle("on", ed.loop);
  document.querySelectorAll("#chanSeg button").forEach(btn => {
    const k = btn.dataset.ch;
    btn.classList.toggle("on", k === "all" ? ed.chans.every(Boolean) : ed.chans[+k] && !ed.chans.every(Boolean));
  });
  document.querySelectorAll("#scaleSeg button").forEach(btn => btn.classList.toggle("on", btn.dataset.v === ed.scale));
  document.querySelectorAll("#colourSeg button").forEach(btn => btn.classList.toggle("on", btn.dataset.v === ed.colour));
  document.querySelectorAll("#specSeg button").forEach(btn => btn.classList.toggle("on", SPV.on));
  $("penBtn").classList.toggle("on", pen.on);
  $("tnBtn").classList.toggle("on", tn.on);
  editButtons();
  rpTick();
}

function saveView(now) {
  if (!ed.doc) return;
  const tnow = performance.now();
  if (!now && tnow - (ed.savedAt || 0) < 500) {
    if (!ed.saveTimer) ed.saveTimer = setTimeout(() => { ed.saveTimer = 0; saveView(true); }, 500);
    return;
  }
  clearTimeout(ed.saveTimer);
  ed.saveTimer = 0;
  ed.savedAt = tnow;
  try { localStorage.setItem("studioView:" + ed.doc.id, JSON.stringify({ start: ed.view.start, spp: ed.view.spp, cursor: ed.cursor, a: ed.sel.a, b: ed.sel.b, chans: ed.chans })); } catch {}
}

function chanSeg() {
  const seg = $("chanSeg"), ch = ed.doc.channels;
  seg.innerHTML = "";
  seg.classList.toggle("hidden", ch < 2);
  if (ch < 2) return;
  const add = (label, key) => { const b = document.createElement("button"); b.className = "segbtn"; b.dataset.ch = key; b.textContent = label; seg.appendChild(b); };
  for (let c = 0; c < ch; c++) add(chanName(c, ch), String(c));
  add(ch === 2 ? "L+R" : t("All"), "all");
}

function docInfoText() {
  const d = ed.doc, chs = d.channels === 1 ? t("mono") : d.channels === 2 ? t("stereo") : d.channels + " ch";
  return [(d.sampleRate / 1000).toLocaleString() + " kHz", d.bits ? d.bits + "-bit" : (d.ext || "").toUpperCase(), chs, fmtDur(d.frames / d.sampleRate)].join(" · ");
}

function applyState(st) {
  const prevIdx = ed.histIdx;
  for (const a of st.allocs) ed.srcs[a.id] = { levels: allocPyr(a) };
  ed.clip = { lists: st.lists, cum: st.lists.map(cumOf), edges: st.edges, len: st.len };
  ed.doc.frames = st.len;
  ed.ver = st.ver;
  ed.hist = st.hist;
  ed.histIdx = st.idx;
  ed.clipInfo = st.clip;
  ed.marks = st.marks || [];
  ed.markDrag = null;
  if (st.saveErr && st.saveErr !== ed.saveErr) tell(t("Studio could not save your latest edits in this browser.") + " (" + (st.saveErr === "quota" ? t("Browser storage is full. Remove files from Studio's list to make room.") : st.saveErr) + ")");
  ed.saveErr = st.saveErr || null;
  ed.raw = null;
  ed.rawWant = null;
  $("docInfo").textContent = docInfoText();
  editButtons();
  if (!$("hist").classList.contains("hidden")) renderHist();
  if (!$("locs").classList.contains("hidden")) renderLocs();
  dgAfterEdit();
  spAfterEdit();
  ldAfterEdit();
  fxAfterEdit();
  mdAfterEdit();
  trAfterEdit();
  tnAfterEdit(prevIdx);
}

function showOpened(r) {
  showDoc(r.meta, r.peaks, r.bands, r.state);
  if (r.recovered) tell(t("Studio restored this file's edit history from its last good save. The most recent edit may be missing."), t("History restored"));
}

function showDoc(meta, peaks, bands, state) {
  stopPlay();
  dgReset();
  ed.doc = Object.assign({}, meta);
  ed.srcs = [{ levels: poolPyr(meta, peaks, bands) }];
  applyState(state);
  ed.chans = new Array(meta.channels).fill(true);
  ed.markSel = null;
  ed.zoomBack = null;
  ed.sel = { a: 0, b: 0 };
  ed.cursor = 0;
  spDoc();
  $("empty").classList.add("hidden");
  $("ed").classList.remove("hidden");
  $("docName").textContent = meta.name;
  $("docName").title = meta.name + "\n" + t("Click for the file tags");
  const sl = srcLabel(meta.source);
  $("docSrc").textContent = sl ? sl + " · " + t("read-only original") : "";
  $("docSrc").classList.toggle("hidden", !sl);
  chanSeg();
  const F = ed.doc.frames;
  ed.view.spp = F / viewWidth();
  ed.view.start = 0;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("studioView:" + meta.id) || "null"); } catch {}
  if (saved) {
    if (Number.isFinite(saved.spp)) ed.view.spp = saved.spp;
    if (Number.isFinite(saved.start)) ed.view.start = saved.start;
    if (Number.isFinite(saved.cursor)) ed.cursor = Math.min(F, Math.max(0, saved.cursor));
    if (Number.isFinite(saved.a) && Number.isFinite(saved.b) && saved.b <= F) ed.sel = { a: saved.a, b: saved.b };
    if (Array.isArray(saved.chans) && saved.chans.length === meta.channels && saved.chans.some(Boolean)) ed.chans = saved.chans;
  }
  clampView();
  try { localStorage.setItem("studioLastDoc", meta.id); } catch {}
  ed.meter = { pk: [], rms: [], hold: [], holdT: [], clip: [], t: 0 };
  drawMeters();
  redraw();
  closeFiles();
  nrDoc();
  humDoc();
  ldDoc();
  repDocChanged();
  nlDocChanged();
  fxDoc();
  mdDoc();
  trDoc();
  tourDoc();
}

function closeDoc() {
  stopPlay();
  dgReset();
  closeDiag();
  ed.doc = null;
  ed.srcs = [];
  ed.clip = null;
  ed.raw = null;
  ed.marks = [];
  ed.markSel = null;
  ed.zoomBack = null;
  tnClose();
  spDoc();
  closeHist();
  closeLocs();
  $("ed").classList.add("hidden");
  $("empty").classList.remove("hidden");
  try { localStorage.removeItem("studioLastDoc"); } catch {}
  call({ t: "close" }).catch(() => {});
  refreshFiles();
}

async function openDoc(id) {
  if (ses.open) await ssClose(true);
  try {
    showOpened(await call({ t: "open", id }));
  } catch (e) { openError(e, ""); }
}

function openError(e, name) {
  const msg = e && e.message === "locked" ? t("This file is open in another Studio tab.") : e && e.message === "quota" ? t("Browser storage is full. Remove files from Studio's list to make room.") : e && e.message === "cancelled" ? "" : (e && e.message) || String(e);
  if (!msg) return;
  tell((name ? name + ": " : "") + msg, t("Could not open the file"));
}

async function importFiles(files) {
  const all = [...files].filter(f => f && f.size > 0), cues = all.filter(f => /\.cue$/i.test(f.name)), list = all.filter(f => !/\.cue$/i.test(f.name));
  if (!list.length) { if (cues.length && ed.doc) ftCueFile(cues[0]); return; }
  for (const f of list) {
    ed.importing = { name: f.name, frac: 0 };
    importProgress({ name: f.name, frac: 0 });
    try {
      const r = await call({ t: "import", file: f });
      if (ses.open) { $("busy").classList.add("hidden"); await ssAddDoc(r.meta.id); }
      else showOpened(r);
    } catch (e) { openError(e, f.name); }
  }
  ed.importing = null;
  $("busy").classList.add("hidden");
  refreshFiles();
  call({ t: "persist" }).catch(() => {});
  if (cues.length && ed.doc) ftCueFile(cues[0]);
}

function importProgress(m) {
  const box = $("busy");
  box.classList.remove("hidden");
  $("busyTitle").textContent = m.phase === "download" ? t("Downloading") : t("Reading");
  $("busyName").textContent = m.name;
  $("busyBar").style.width = Math.round((m.frac || 0) * 100) + "%";
  $("busyPct").textContent = m.phase === "download" && !m.total ? fmtBytes(m.bytes || 0) : Math.round((m.frac || 0) * 100) + "%" + (m.phase === "download" && m.total ? " · " + fmtBytes(m.total) : "");
}

function closeFiles() { $("files").classList.add("hidden"); }

function srcLabel(src) {
  if (!src) return "";
  if (src.kind === "library") return t("Library");
  if (src.kind === "locker") return t("Locker");
  if (src.kind === "session") return t("Session mix");
  if (src.kind === "dj") return t("DJ recording");
  return "";
}

function openFiles(tab) {
  $("files").classList.remove("hidden");
  setTab(tab || ed.tab || "studio");
}

function setTab(tab) {
  ed.tab = tab;
  document.querySelectorAll("#files .ftab").forEach(b => b.classList.toggle("on", b.dataset.tab === tab));
  document.querySelectorAll("#files .fpane").forEach(p => p.classList.toggle("hidden", p.dataset.pane !== tab));
  if (tab === "studio") refreshFiles();
  if (tab === "library") { libHint(); setTimeout(() => $("libQ").focus(), 30); }
  if (tab === "locker") { loadLocker(); setTimeout(() => $("lkQ").focus(), 30); }
  if (tab === "albums") alTab();
  if (tab === "sessions") ssFilesTab();
}

async function myAccount() {
  if (ed.account) return ed.account;
  try { const r = await fetch("/api/me", { cache: "no-store" }); if (r.ok) ed.account = await r.json(); } catch {}
  return ed.account || {};
}

function rowEl(title, info, onClick, extra) {
  const row = document.createElement("div");
  row.className = "frow";
  const name = document.createElement("button");
  name.className = "fname";
  name.title = title;
  name.innerHTML = `<span class="fn"></span><span class="fi"></span>`;
  name.querySelector(".fn").textContent = title;
  name.querySelector(".fi").textContent = info;
  name.addEventListener("click", onClick);
  if (extra) { const tag = document.createElement("span"); tag.className = "ftag"; tag.textContent = extra; name.prepend(tag); }
  row.appendChild(name);
  return row;
}

function listNote(box, text) {
  box.innerHTML = "";
  const p = document.createElement("div");
  p.className = "fempty";
  p.textContent = text;
  box.appendChild(p);
}

async function libHint() {
  const box = $("libList");
  const acct = await myAccount();
  if (acct && acct.library === false) { $("libQ").disabled = true; listNote(box, t("No music library is connected to your account.")); return; }
  $("libQ").disabled = false;
  if ($("libQ").value.trim().length < 2) listNote(box, t("Type at least two letters to search."));
}

async function libSearch() {
  const q = $("libQ").value.trim(), box = $("libList");
  if (q.length < 2) { libHint(); return; }
  const seq = ++ed.libSeq;
  listNote(box, t("Searching…"));
  let items;
  try {
    const r = await fetch("/api/search?q=" + encodeURIComponent(q), { cache: "no-store" });
    if (r.status === 401) { listNote(box, t("Your session has ended. Log in again.")); return; }
    if (!r.ok) throw new Error(String(r.status));
    items = await r.json();
  } catch { if (seq === ed.libSeq) listNote(box, t("Could not search the library.")); return; }
  if (seq !== ed.libSeq) return;
  if (!Array.isArray(items) || !items.length) { listNote(box, t("No matches.")); return; }
  box.innerHTML = "";
  for (const it of items) {
    const title = it.title || it.id;
    const info = [it.artist, it.album, it.duration ? fmtDur(it.duration) : "", it.sampleRate ? (it.sampleRate / 1000) + " kHz" : ""].filter(Boolean).join(" · ");
    box.appendChild(rowEl(title, info, () => importRemote({ kind: "library", id: String(it.id), title: it.title || "", artist: it.artist || "", album: it.album || "" })));
  }
}

async function loadLocker(force) {
  const box = $("lkList");
  if (!force && ed.locker && Date.now() - ed.locker.t < 60000) { renderLocker(); return; }
  listNote(box, t("Loading…"));
  try {
    const r = await fetch("/api/locker/files", { cache: "no-store" });
    if (r.status === 401) { listNote(box, t("Your session has ended. Log in again.")); return; }
    if (!r.ok) throw new Error(String(r.status));
    const j = await r.json();
    ed.locker = { t: Date.now(), files: Array.isArray(j.files) ? j.files : [] };
  } catch { listNote(box, t("Could not load the Locker.")); $("lkInfo").textContent = ""; return; }
  renderLocker();
}

function renderLocker() {
  const box = $("lkList"), files = ed.locker ? ed.locker.files : [];
  if (!files.length) { listNote(box, t("Your Locker is empty. Upload files in Delicate DJ.")); $("lkInfo").textContent = ""; return; }
  const q = $("lkQ").value.trim().toLowerCase();
  const hits = q ? files.filter(f => [f.title, f.artist, f.album, f.path].join(" ").toLowerCase().includes(q)) : files;
  box.innerHTML = "";
  if (!hits.length) listNote(box, t("No matches."));
  for (const f of hits.slice(0, 300)) {
    const ext = (f.path || "").split(".").pop().toLowerCase();
    const info = [f.artist, f.album, f.duration ? fmtDur(f.duration) : "", f.size ? fmtBytes(f.size) : "", f.folder].filter(Boolean).join(" · ");
    box.appendChild(rowEl(f.title || f.path, info, () => importRemote({ kind: "locker", id: String(f.id), title: f.title || "", artist: f.artist || "", album: f.album || "", path: f.path || "" }, ext), ext ? ext.toUpperCase() : ""));
  }
  $("lkInfo").textContent = hits.length > 300 ? t("Showing 300 of") + " " + hits.length + " — " + t("refine the filter") : files.length + " " + t("files in your Locker");
}

async function importRemote(src, ext) {
  closeFiles();
  const have = (ed.docs || []).find(d => d.source && d.source.kind === src.kind && d.source.id === src.id);
  if (have) { if (ses.open) ssAddDoc(have.id); else openDoc(have.id); return; }
  const name = [src.artist, src.title].filter(Boolean).join(" - ") || src.path || src.id;
  importProgress({ name, frac: 0, phase: "download" });
  try {
    const r = await call({ t: "import", url: "/api/stream/" + encodeURIComponent(src.id), name, ext: ext || "", source: src });
    if (ses.open) { $("busy").classList.add("hidden"); await ssAddDoc(r.meta.id); }
    else showOpened(r);
  } catch (e) {
    if (e && e.message === "login") tell(t("Your session has ended. Log in again."));
    else if (e && e.message === "network") tell(t("The download was interrupted. Try again."), t("Could not open the file"));
    else openError(e, name);
  }
  $("busy").classList.add("hidden");
  refreshFiles();
  call({ t: "persist" }).catch(() => {});
}

async function refreshFiles() {
  let r;
  try { r = await call({ t: "list" }); } catch { return; }
  ed.docs = r.docs;
  for (const box of [$("recentList"), $("filesList")]) {
    box.innerHTML = "";
    if (!r.docs.length) {
      const p = document.createElement("div");
      p.className = "fempty";
      p.textContent = t("No files yet.");
      box.appendChild(p);
      continue;
    }
    for (const d of r.docs) {
      const row = document.createElement("div");
      row.className = "frow" + (ed.doc && ed.doc.id === d.id ? " cur" : "");
      const name = document.createElement("button");
      name.className = "fname";
      name.title = d.name;
      name.innerHTML = `<span class="fn"></span><span class="fi"></span>`;
      name.querySelector(".fn").textContent = d.name;
      name.querySelector(".fi").textContent = [srcLabel(d.source), fmtDur((d.len || d.frames) / d.sampleRate), (d.sampleRate / 1000) + " kHz", d.bits ? d.bits + "-bit" : (d.ext || "").toUpperCase(), d.channels === 1 ? t("mono") : d.channels === 2 ? t("stereo") : d.channels + " ch", d.edits ? d.edits + " " + t(d.edits === 1 ? "edit" : "edits") : "", fmtBytes(d.frames * d.channels * 4 + (d.heapBytes || 0))].filter(Boolean).join(" · ");
      name.addEventListener("click", () => { if (ses.open) { closeFiles(); ssAddDoc(d.id); } else openDoc(d.id); });
      const x = document.createElement("button");
      x.className = "x fdel";
      x.title = t("Remove from Studio");
      x.setAttribute("aria-label", t("Remove from Studio"));
      x.textContent = "×";
      x.addEventListener("click", async ev => {
        ev.stopPropagation();
        if (!(await ask(t("Remove from Studio?"), d.name + "\n\n" + t("This deletes Studio's working copy from this browser. Your original file is not touched."), { ok: t("remove") }))) return;
        try {
          await call({ t: "remove", id: d.id });
          try { localStorage.removeItem("studioView:" + d.id); } catch {}
          if (ed.doc && ed.doc.id === d.id) closeDoc(); else refreshFiles();
        } catch (e) { tell(e && e.message === "exporting" ? t("This file is being exported or is used in the open session. Remove it when the render has finished or the session is closed.") : String(e.message || e)); }
      });
      row.appendChild(name);
      row.appendChild(x);
      box.appendChild(row);
    }
  }
  const info = r.quota ? t("Browser storage") + ": " + fmtBytes(r.usage) + " / " + fmtBytes(r.quota) + (r.persisted ? "" : " · " + t("may be cleared by the browser")) : "";
  $("storeInfo").textContent = info;
  $("storeInfo2").textContent = info;
}

function pickFiles() { $("fileIn").click(); }

function playhead() {
  if (!ed.play.on || !ed.ring) return ed.cursor;
  const ctrl = ed.ring.ctrl, sr = ed.doc.sampleRate;
  const lat = ed.ctx ? Math.round(((ed.ctx.outputLatency || 0) + (ed.ctx.baseLatency || 0)) * sr) : 0;
  const r = Math.max(0, Atomics.load(ctrl, 2) - lat);
  const len = ed.play.end - ed.play.start;
  return ed.play.loop ? ed.play.start + ((r + ed.play.off) % len) : Math.min(ed.play.end, ed.play.start + r);
}

async function ensureAudio() { return ensureAudioFor(ed.doc.sampleRate, ed.doc.channels); }

async function ensureAudioFor(sr, ch) {
  const doc = { sampleRate: sr, channels: ch };
  if (ed.ctx && (ed.ctx.sampleRate === sr || ed.ctxRate === sr) && ed.node && ed.nodeCh === ch) {
    if (ed.ctx.state !== "running") await ed.ctx.resume();
    return;
  }
  if (ed.ctx) { try { await ed.ctx.close(); } catch {} }
  let ctx;
  try { ctx = new AudioContext({ sampleRate: doc.sampleRate, latencyHint: "interactive" }); }
  catch { ctx = new AudioContext({ latencyHint: "interactive" }); }
  await ctx.audioWorklet.addModule("/player-worklet.js");
  const data = new SharedArrayBuffer(RING * doc.channels * 4), ctrl = new SharedArrayBuffer(8 * 4);
  const node = new AudioWorkletNode(ctx, "studio-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [doc.channels], processorOptions: { data, ctrl, size: RING, channels: doc.channels } });
  node.port.onmessage = e => meterIn(e.data);
  node.connect(ctx.destination);
  scWire(ctx, node, doc.channels);
  ed.ctx = ctx;
  ed.ctxRate = sr;
  ed.node = node;
  ed.nodeCh = doc.channels;
  ed.ring = { data: new Float32Array(data), ctrl: new Int32Array(ctrl) };
  ed.worker.postMessage({ t: "ring", data, ctrl, size: RING });
  if (ctx.state !== "running") await ctx.resume();
  if (ctx.sampleRate !== doc.sampleRate) tell(t("This browser plays the file resampled to") + " " + ctx.sampleRate + " Hz.");
}

async function startPlay(from) {
  if (!ed.doc) return;
  await ensureAudio();
  const F = ed.doc.frames, selOn = ed.sel.b > ed.sel.a;
  let pos = Math.floor(from !== undefined ? from : (selOn ? ed.sel.a : ed.cursor));
  let rs = 0, re = F, loop = ed.loop;
  if (selOn && pos >= ed.sel.a && pos < ed.sel.b) { rs = Math.floor(ed.sel.a); re = Math.floor(ed.sel.b); }
  else if (selOn) loop = false;
  if (pos >= re - 1) { if (from !== undefined && !loop) return; pos = rs; }
  if (!loop) rs = pos;
  if (re - rs < 1) return;
  Atomics.store(ed.ring.ctrl, 0, 0);
  ed.play = { on: true, start: rs, end: re, loop, off: loop ? pos - rs : 0, t0: performance.now() };
  ed.worker.postMessage({ t: "play", start: rs, end: re, loop, off: ed.play.off });
  tick();
}

function stopPlay(keep) {
  if (!ed.play.on) return;
  const pos = playhead();
  ed.play.on = false;
  if (ed.ring) Atomics.store(ed.ring.ctrl, 0, 0);
  ed.worker.postMessage({ t: "stop" });
  if (keep === "here") ed.cursor = Math.floor(pos);
  redraw();
}

function togglePlay() { if (ed.play.on) stopPlay(); else startPlay(); }

function tick() {
  if (!ed.play.on) { redraw(); return; }
  const st = Atomics.load(ed.ring.ctrl, 0);
  if (st === 2) { stopPlay(); return; }
  if (st === 0 && performance.now() - ed.play.t0 > 2000) { stopPlay(); tell(t("Playback did not start.")); return; }
  const ph = playhead(), W = viewWidth(), vis = W * ed.view.spp;
  if (!ed.dragging && (ph > ed.view.start + vis * 0.98 || ph < ed.view.start)) { ed.view.start = ph - vis * 0.02; clampView(); }
  render();
  requestAnimationFrame(tick);
}

function meterIn(m) {
  const now = performance.now(), M = ed.meter;
  for (let c = 0; c < m.pk.length; c++) {
    const pk = m.pk[c], db = pk > 0 ? 20 * Math.log10(pk) : -120;
    M.pk[c] = Math.max(db, (M.pk[c] ?? -120));
    M.rms[c] = m.rms[c] > 0 ? 20 * Math.log10(m.rms[c]) : -120;
    if (db >= (M.hold[c] ?? -120) || now - (M.holdT[c] || 0) > 1500) { M.hold[c] = db; M.holdT[c] = now; }
    if (pk >= 0.9999) M.clip[c] = true;
  }
  if (!ed.meterRaf) ed.meterRaf = requestAnimationFrame(drawMeters);
}

function drawMeters() {
  ed.meterRaf = 0;
  const cv = ses.open ? $("sesMeter") : $("mt"), dpr = canvasFit(cv), g = cv.getContext("2d");
  const W = cv.width, H = cv.height, M = ed.meter, now = performance.now(), on = ed.play.on || ses.play.on;
  const ch = ses.open ? 2 : ed.doc ? ed.doc.channels : 2;
  const dt = M.t ? (now - M.t) / 1000 : 0;
  M.t = now;
  g.fillStyle = TH.canvas;
  g.fillRect(0, 0, W, H);
  const clipW = 14 * dpr, barW = W - clipW - 4 * dpr, scaleH = 11 * dpr;
  const rowH = Math.max(3 * dpr, (H - scaleH - (ch + 1) * 2 * dpr) / ch);
  const xOfDb = db => Math.max(0, Math.min(1, (db + 60) / 60)) * barW;
  let active = false;
  for (let c = 0; c < ch; c++) {
    const y = 2 * dpr + c * (rowH + 2 * dpr);
    g.fillStyle = TH.meterBg;
    g.fillRect(0, y, barW, rowH);
    let pk = M.pk[c] ?? -120;
    if (!on) pk -= 30 * dt;
    pk = Math.max(-120, pk - 20 * dt);
    M.pk[c] = pk;
    if (pk > -60) active = true;
    const rms = on ? (M.rms[c] ?? -120) : -120;
    const grad = g.createLinearGradient(0, 0, barW, 0);
    grad.addColorStop(0, TH.blue);
    grad.addColorStop(xOfDb(-18) / barW, TH.blue);
    grad.addColorStop(xOfDb(-12) / barW, TH.gold);
    grad.addColorStop(xOfDb(-3) / barW, TH.pink);
    grad.addColorStop(1, TH.peak);
    g.globalAlpha = 0.45;
    g.fillStyle = grad;
    g.fillRect(0, y, xOfDb(pk), rowH);
    g.globalAlpha = 1;
    g.fillRect(0, y + rowH * 0.25, xOfDb(rms), rowH * 0.5);
    const hold = M.hold[c] ?? -120;
    if (hold > -60 && now - (M.holdT[c] || 0) < 3000) { g.fillStyle = TH.ink; g.fillRect(xOfDb(hold) - dpr, y, 2 * dpr, rowH); active = true; }
    g.fillStyle = M.clip[c] ? TH.peak : TH.meterOff;
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
  if (active || on) ed.meterRaf = requestAnimationFrame(drawMeters);
}

const EDIT_LABELS = { open: "Original", delete: "Delete", cut: "Cut", paste: "Paste", silence: "Silence", crop: "Crop", insert: "Insert silence", heal: "Heal", pencil: "Pencil", repair: "Repair", nr: "Noise Reduction", hum: "DeHummer", declip: "DeClipper", spot: "Spot Healing", spheal: "Spectral heal", spdel: "Remove frequencies", loud: "Match loudness", norm: "Normalize", amp: "Amplify", fx: "Effects" };

function selOn() { return ed.sel.b > ed.sel.a; }

function editButtons() {
  if (!ed.doc) return;
  const has = selOn(), set = (id, on) => { const b = $(id); if (b) b.disabled = !on; };
  set("undoBtn", ed.histIdx > 0);
  set("redoBtn", ed.histIdx < ed.hist.length - 1);
  for (const id of ["cutBtn", "copyBtn", "delBtn", "silBtn", "cropBtn"]) set(id, has);
  set("pasteBtn", !!ed.clipInfo);
  $("histN").textContent = ed.histIdx ? String(ed.histIdx) : "";
}

function mapPos(p, h) {
  if (!h || h.ch) return p;
  if (h.op === "delete" || h.op === "cut" || h.op === "paste" || h.op === "insert") return p < h.a ? p : p < h.b ? h.a : p - (h.b - h.a) + (h.op === "paste" || h.op === "insert" ? h.n : 0);
  if (h.op === "crop") return p >= h.a && p < h.b ? p - h.a : 0;
  return p;
}

function setSelFrom(sel) {
  const F = ed.doc.frames;
  if (!sel) { ed.sel = { a: Math.min(ed.sel.a, F), b: Math.min(ed.sel.b, F) }; ed.cursor = Math.min(ed.cursor, F); if (ed.sel.b <= ed.sel.a) ed.sel = { a: 0, b: 0 }; return; }
  const a = Math.max(0, Math.min(F, sel.a)), b = Math.max(0, Math.min(F, sel.b));
  ed.sel = b > a ? { a, b } : { a: 0, b: 0 };
  ed.cursor = Math.max(0, Math.min(F, sel.cursor !== undefined ? sel.cursor : a));
}

function editError(e) {
  const m = e && e.message || String(e);
  if (m === "stale" || m === "nothing" || m === "cancelled" || pxErr(m)) return;
  if (m === "hum-short") { tell(t("Select at least a second of audio to look for hum."), t("DeHummer")); return; }
  if (m === "print-none" || m.startsWith("print-rate:") || m.startsWith("print-short:") || m === "changed" || m === "auto-none") { tell(nrErrText(m), t("Noise Reduction")); return; }
  if (m === "nosel") { tell(t("Select a range first.")); return; }
  if (m === "noclip") { tell(t("The clipboard is empty.")); return; }
  if (m === "empty") { tell(t("A file can't be empty. Select less, or close the file instead.")); return; }
  if (m.startsWith("rate:")) { tell(t("The clipboard holds audio at a different sample rate") + " (" + (Number(m.slice(5)) / 1000).toLocaleString() + " kHz). " + t("Sample-rate conversion arrives with export."), t("Could not paste")); return; }
  if (m === "quota") { tell(t("Browser storage is full. Remove files from Studio's list to make room.")); return; }
  if (m === "heal-long") { tell(t("Heal works on selections of up to 4 s. Select just the damaged part, or use the DeClicker for many clicks."), t("Could not heal")); return; }
  if (m === "spot-nothing") { flash(t("Nothing there stands out from its surroundings, so nothing was changed.")); return; }
  if (m === "spec-long") { tell(t("A spectral selection can be healed up to 60 s at a time."), t("Could not heal")); return; }
  if (m === "heal-edge") { tell(t("Heal needs some audio on both sides of the selection."), t("Could not heal")); return; }
  if (m === "heal-failed") { tell(t("This selection could not be healed."), t("Could not heal")); return; }
  tell(m, t("Could not edit"));
}

async function runEdit(msg, structural, keepView) {
  if (!ed.doc || ed.editing) return;
  const wasPlaying = ed.play.on && structural, ph = wasPlaying ? playhead() : 0;
  if (wasPlaying) stopPlay();
  ed.editing = true;
  try {
    const r = await call(Object.assign({ id: ed.doc.id, a: ed.sel.a, b: ed.sel.b, cursor: ed.cursor, chans: ed.chans, xfade: ed.xfade, snap: ed.snap, have: ed.srcs.length }, msg));
    if (!ed.doc) return;
    if (r.t === "copied") {
      ed.clipInfo = r.clip;
      flash(t("Copied") + " " + fmtTime(r.clip.n) + " · " + (r.clip.ch === 1 ? t("mono") : r.clip.ch === 2 ? t("stereo") : r.clip.ch + " ch"));
      setSelFrom(r.sel);
      editButtons();
      redraw();
      return;
    }
    const h = msg.t === "edit" ? r.hist[r.idx] : null;
    applyState(r);
    setSelFrom(r.sel);
    if (!keepView) ensureVisible(ed.cursor);
    clampView();
    redraw();
    if (wasPlaying) startPlay(Math.max(0, Math.min(ed.doc.frames - 1, Math.round(h ? mapPos(ph, h) : ph))));
    return r;
  } catch (e) { editError(e); }
  finally { ed.editing = false; }
}

function edit(op, extra) {
  if (!ed.doc) return;
  if (["cut", "copy", "delete", "silence", "crop", "heal"].includes(op) && !selOn()) return;
  if (op === "paste" && !ed.clipInfo) return;
  return runEdit(Object.assign({ t: "edit", op }, extra || {}), op !== "copy" && op !== "heal", op === "heal");
}

function flash(text, ms) {
  const el = $("stMsg");
  el.textContent = text;
  clearTimeout(ed.flashT);
  ed.flashT = setTimeout(() => { el.textContent = ""; }, ms || 3000);
}
const isMarkOp = h => !!h && h.op.startsWith("mark");
function audioKey() {
  let i = ed.histIdx;
  while (i > 0 && isMarkOp(ed.hist[i])) i--;
  const h = ed.hist[i];
  return (ed.doc ? ed.doc.id : "") + ":" + i + ":" + (h ? h.op + ":" + h.t : "");
}
function undo() { if (ed.histIdx > 0) { const m = isMarkOp(ed.hist[ed.histIdx]); runEdit({ t: "undo" }, !m, m); } }
function redo() { if (ed.histIdx < ed.hist.length - 1) { const m = isMarkOp(ed.hist[ed.histIdx + 1]); runEdit({ t: "redo" }, !m, m); } }
function jumpHist(idx) { if (idx !== ed.histIdx) runEdit({ t: "jump", idx }, true); }

async function insertSilenceDlg() {
  if (!ed.doc) return;
  const def = fmtTime(ed.doc.sampleRate);
  const v = await askForm(t("Insert silence"), `<label class="dfield"><span>${esc(t("Duration"))}</span><input name="dur" value="${esc(def)}" spellcheck="false" autocomplete="off" inputmode="decimal"></label><div class="dnote">${esc(selOn() ? t("Goes in at the start of the selection.") : t("Goes in at the cursor."))}</div>`, { ok: t("insert"), setup: f => requestAnimationFrame(() => { const i = f.querySelector("input"); if (i) i.select(); }) });
  if (!v) return;
  const n = parseTime(v.dur, ed.fmt);
  if (!n || n <= 0) { tell(t("Enter a duration such as") + " " + def + "."); return; }
  edit("insert", { n });
}

function histLabel(h) {
  if (isMarkOp(h)) {
    const k = h.mk || {}, nm = k.name ? " · " + k.name : "";
    if (h.op === "marktracks") return (h.n === 1 ? t("Split into 1 track") : t("Split into {n} tracks").replace("{n}", h.n)) + " · " + fmtTime(h.a) + "–" + fmtTime(h.b);
    if (h.op === "markadd") return t(k.kind === "range" ? "Add range" : k.kind === "view" ? "Add view" : "Add marker") + " " + k.n + nm;
    if (h.op === "markdel") return t("Delete location") + " " + k.n + nm;
    if (k.what === "rename") return t("Rename location") + " " + k.n + " → " + (k.name || "");
    if (k.what === "move") return t("Move location") + " " + k.n + " → " + fmtTime(h.a) + nm;
    return t("Change location") + " " + k.n + nm;
  }
  const name = t(EDIT_LABELS[h.op] || PX_NAMES[h.op] || h.op);
  if (h.op === "open") return name;
  const ch = h.ch ? " · " + h.ch : "";
  if (h.op === "insert") return name + " " + fmtTime(h.n) + " @ " + fmtTime(h.a) + ch;
  if (h.op === "dc") return name + " " + pxPct(h.n / 1e6) + " · " + fmtTime(h.a) + "–" + fmtTime(h.b) + ch;
  if (h.op === "loud" || h.op === "norm" || h.op === "amp") return name + " " + (h.n > 0 ? "+" : h.n < 0 ? "−" : "") + Math.abs(h.n).toFixed(1) + " dB · " + fmtTime(h.a) + "–" + fmtTime(h.b) + ch;
  if (h.op === "repair") return (h.n === 1 ? t("Repair 1 click") : t("Repair {n} clicks").replace("{n}", h.n)) + " · " + fmtTime(h.a) + "–" + fmtTime(h.b);
  if (h.op === "declip") return (h.n === 1 ? t("Repair 1 clipped span") : t("Repair {n} clipped spans").replace("{n}", h.n)) + " · " + fmtTime(h.a) + "–" + fmtTime(h.b);
  if (h.op === "paste") return name + " " + fmtTime(h.n) + " @ " + fmtTime(h.a) + (h.b > h.a && !h.ch ? " " + t("over") + " " + fmtTime(h.b - h.a) : "") + ch;
  return name + " " + fmtTime(h.a) + "–" + fmtTime(h.b) + ch;
}

function renderHist() {
  const box = $("histList");
  box.innerHTML = "";
  ed.hist.forEach((h, i) => {
    const row = document.createElement("button");
    row.className = "hrow" + (i === ed.histIdx ? " cur" : "") + (i > ed.histIdx ? " undone" : "");
    row.innerHTML = `<span class="hn"></span><span class="hl"></span><span class="ht"></span>`;
    row.querySelector(".hn").textContent = i;
    row.querySelector(".hl").textContent = histLabel(h);
    row.querySelector(".ht").textContent = h.t ? new Date(h.t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
    row.addEventListener("click", () => jumpHist(i));
    box.appendChild(row);
  });
  const c = box.querySelector(".cur");
  if (c) c.scrollIntoView({ block: "nearest" });
  $("histInfo").textContent = ed.hist.length > 1 ? t("Click a step to go back to it. Later steps stay until you make a new edit.") : t("No edits yet. Every edit is listed here and can be undone.");
}

function nextFreeN() {
  const used = new Set((ed.marks || []).map(m => m.n));
  let n = 1;
  while (used.has(n)) n++;
  return n;
}

function markEdit(op, markId, mark) {
  return runEdit({ t: "edit", op, markId, mark }, false, true);
}

function markTime(m) {
  if (m.kind === "view") return t("View");
  if (m.kind === "range") return fmtTime(m.a) + "–" + fmtTime(m.b);
  return fmtTime(m.a);
}

function addMarker(rangeOnly) {
  if (!ed.doc) return;
  const n = nextFreeN();
  if (rangeOnly || (selOn() && !ed.play.on)) {
    if (!selOn()) return;
    markEdit("markadd", null, { n, kind: "range", a: ed.sel.a, b: ed.sel.b, chans: ed.chans.every(Boolean) ? null : ed.chans.slice(), name: t("Range") + " " + n });
    return;
  }
  const pos = ed.play.on ? Math.floor(playhead()) : ed.cursor;
  markEdit("markadd", null, { n, kind: "point", a: pos, name: t("Marker") + " " + n });
  flash(t("Marker") + " " + n + " @ " + fmtTime(pos));
}

function segHtml(name, items, v) {
  return `<div class="seg dseg" data-name="${name}">` + items.map(([k, label]) => `<button type="button" class="segbtn${k === v ? " on" : ""}" data-v="${k}">${esc(t(label))}</button>`).join("") + `</div>`;
}

function segSetup(form) {
  form.querySelectorAll(".dseg").forEach(seg => seg.addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b) return;
    seg.querySelectorAll("button").forEach(x => x.classList.toggle("on", x === b));
  }));
}

function segRead(form) {
  const out = {};
  form.querySelectorAll(".dseg").forEach(seg => { const on = seg.querySelector(".on"); out[seg.dataset.name] = on ? on.dataset.v : ""; });
  return out;
}

async function addLocationDlg() {
  if (!ed.doc) return;
  const n = nextFreeN(), hasSel = selOn();
  const html = `<label class="dfield"><span>${esc(t("Name"))}</span><input name="name" value="${esc((hasSel ? t("Range") : t("Marker")) + " " + n)}" spellcheck="false" autocomplete="off"></label>`
    + `<div class="dfield"><span>${esc(t("Time"))}</span>${segHtml("time", [["point", "Marker at the cursor"], ["range", "Selection"], ["view", "None"]], hasSel ? "range" : "point")}</div>`
    + `<div class="dfield"><span>${esc(t("Zoom and view"))}</span>${segHtml("zoom", [["0", "Don't store"], ["1", "Store"]], "0")}</div>`;
  const v = await askForm(t("New location") + " " + n, html, { ok: t("add"), setup: f => { segSetup(f); requestAnimationFrame(() => { const i = f.querySelector("input"); if (i) i.select(); }); }, read: () => segRead(document.querySelector("#dlg .dform")) });
  if (!v) return;
  if (v.time === "range" && !hasSel) { tell(t("Select a range first.")); return; }
  const mark = { n, kind: v.time, name: (v.name || "").trim() || t("Marker") + " " + n, view: v.zoom === "1" || v.time === "view" ? { start: ed.view.start, spp: ed.view.spp } : null };
  if (v.time === "point") mark.a = ed.play.on ? Math.floor(playhead()) : ed.cursor;
  if (v.time === "range") { mark.a = ed.sel.a; mark.b = ed.sel.b; mark.chans = ed.chans.every(Boolean) ? null : ed.chans.slice(); }
  markEdit("markadd", null, mark);
}

async function renameMark(m) {
  const v = await askText(t("Rename location") + " " + m.n, m.name || "");
  if (v === null || v === undefined) return;
  const name = String(v).trim();
  if (name !== m.name) markEdit("markset", m.id, { name });
}

function recallMark(m) {
  if (!ed.doc || !m) return;
  ed.markSel = m.id;
  if (m.view) { ed.view.spp = m.view.spp; ed.view.start = m.view.start; }
  if (m.kind === "point") { ed.sel = { a: 0, b: 0 }; ed.cursor = Math.min(ed.doc.frames, m.a); }
  if (m.kind === "range") { ed.sel = { a: m.a, b: Math.min(ed.doc.frames, m.b) }; ed.cursor = m.a; if (m.chans && m.chans.length === ed.doc.channels) ed.chans = m.chans.slice(); else ed.chans = ed.chans.map(() => true); }
  clampView();
  if (!m.view && m.kind !== "view") ensureVisible(ed.cursor);
  if (ed.play.on && m.kind !== "view") startPlay(ed.cursor);
  flash(t("Location") + " " + m.n + (m.name ? " · " + m.name : ""));
  redraw();
}

function recallNumber(n) {
  const m = (ed.marks || []).find(x => x.n === n);
  if (m) recallMark(m); else flash(t("No location") + " " + n);
}

function markPositions() {
  const out = [];
  for (const m of ed.marks || []) { if (m.kind === "view") continue; out.push(m.a); if (m.kind === "range") out.push(m.b); }
  return out;
}

function jumpTo(f, keepSel) {
  ed.cursor = Math.max(0, Math.min(ed.doc.frames, Math.round(f)));
  if (!keepSel) ed.sel = { a: 0, b: 0 };
  ensureVisible(ed.cursor);
  if (ed.play.on) startPlay(Math.min(ed.cursor, ed.doc.frames - 1));
  redraw();
}

function stepTo(dir, withEdges) {
  if (!ed.doc) return;
  const here = ed.play.on ? Math.floor(playhead()) : ed.cursor;
  const pos = markPositions();
  if (withEdges) { pos.push(0, ed.doc.frames); if (selOn()) pos.push(ed.sel.a, ed.sel.b); }
  let best = null;
  for (const p of pos) if (dir > 0 ? p > here + 0.5 && (best === null || p < best) : p < here - 0.5 && (best === null || p > best)) best = p;
  if (best !== null) jumpTo(best, withEdges);
}

function renderLocs() {
  const box = $("locsList"), marks = ed.marks || [];
  box.innerHTML = "";
  for (const m of marks) {
    const row = document.createElement("div");
    row.className = "lrow" + (ed.markSel === m.id ? " cur" : "");
    row.innerHTML = `<button class="lgo"><span class="hn"></span><span class="hl"></span><span class="lt"></span><span class="lz"></span></button><button class="x lren" title="Rename" aria-label="Rename">✎</button><button class="x ldel" title="Delete" aria-label="Delete">×</button>`;
    row.querySelector(".hn").textContent = m.n;
    row.querySelector(".hl").textContent = m.name || "";
    row.querySelector(".lt").textContent = markTime(m);
    row.querySelector(".lz").textContent = m.view ? t("zoom") : "";
    row.querySelector(".lgo").addEventListener("click", () => recallMark(m));
    row.querySelector(".lren").addEventListener("click", () => renameMark(m));
    row.querySelector(".ldel").addEventListener("click", () => markEdit("markdel", m.id));
    box.appendChild(row);
  }
  const mk = typeof cmdKeyText === "function" ? cmdKeyText("markAdd") : "M";
  $("locsInfo").textContent = marks.length ? t("Click to go there. Drag markers on the ruler to move them; double-click to rename.") : t("No locations yet.") + " " + (mk ? mk + " — " : "") + t("adds a marker at the cursor, or keeps the selection as a range. New… can also store the zoom.");
}

function popFit(el) {
  el.style.left = "";
  if (getComputedStyle(el).position !== "absolute") return;
  const r = el.getBoundingClientRect(), over = r.right - (innerWidth - 8);
  if (over > 0) el.style.left = -Math.min(over, Math.max(0, r.left - 8)) + "px";
}

function openLocs() { if (!ed.doc) return; closeFiles(); closeHist(); $("locs").classList.remove("hidden"); renderLocs(); popFit($("locs")); }
function closeLocs() { $("locs").classList.add("hidden"); }
function toggleLocs() { if ($("locs").classList.contains("hidden")) openLocs(); else closeLocs(); }

function openHist() { if (!ed.doc) return; closeFiles(); closeLocs(); $("hist").classList.remove("hidden"); renderHist(); popFit($("hist")); }
function closeHist() { $("hist").classList.add("hidden"); }
function toggleHist() { if ($("hist").classList.contains("hidden")) openHist(); else closeHist(); }

function setSelChannels(key) {
  const ch = ed.doc.channels;
  ed.chans = key === "all" ? new Array(ch).fill(true) : ed.chans.map((_, i) => i === +key);
  redraw();
}

function applyPanel(which) {
  if (!ed.doc) return;
  const v = parseTime($(which).value, ed.fmt);
  if (v === null) { updatePanel(); return; }
  const F = ed.doc.frames;
  let a = ed.sel.b > ed.sel.a ? ed.sel.a : ed.cursor, b = ed.sel.b > ed.sel.a ? ed.sel.b : ed.cursor;
  if (which === "selStart") { const len = b - a; a = v; b = len > 0 ? Math.max(a, b) : a; if (len === 0) b = a; }
  else if (which === "selEnd") b = v;
  else b = a + v;
  a = Math.max(0, Math.min(F, a)); b = Math.max(0, Math.min(F, b));
  if (b < a) [a, b] = [b, a];
  if (b > a) ed.sel = { a, b }; else { ed.sel = { a: 0, b: 0 }; ed.cursor = a; }
  ed.cursor = a;
  ensureVisible(a);
  redraw();
}

function wireWave(cv) {
  const spec = cv.id === "sp";
  let autoTimer = 0, lastX = 0, press = null;
  const local = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width }; };
  const auto = () => {
    if (!ed.dragging) return;
    const W = viewWidth();
    let d = 0;
    if (lastX < 0) d = lastX; else if (lastX > W) d = lastX - W;
    if (d) { ed.view.start += d * ed.view.spp * 0.5; clampView(); dragTo(lastX); }
  };
  const dragTo = x => {
    const dg = ed.dragging;
    const f = tnSnap(Math.max(0, Math.min(ed.doc.frames, frameAt(Math.max(0, Math.min(viewWidth(), x))))), dg.free);
    if (dg.mode === "a") { ed.sel.a = f; if (ed.sel.a > ed.sel.b) { [ed.sel.a, ed.sel.b] = [ed.sel.b, ed.sel.a]; dg.mode = "b"; } }
    else if (dg.mode === "b") { ed.sel.b = f; if (ed.sel.b < ed.sel.a) { [ed.sel.a, ed.sel.b] = [ed.sel.b, ed.sel.a]; dg.mode = "a"; } }
    else { ed.sel = { a: Math.min(dg.anchor, f), b: Math.max(dg.anchor, f) }; }
    redraw();
  };
  const cancelPress = () => { if (press) { clearTimeout(press.timer); press = null; } };
  cv.addEventListener("pointerdown", e => {
    if (!ed.doc || e.button > 0 || (IS_MAC && e.ctrlKey) || (spec && SPV.tool !== "time")) return;
    if (!spec && penDown(e, cv, local(e))) return;
    if (!spec && pxDown(e, cv, local(e))) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = local(e);
    lastX = p.x;
    cancelPress();
    if (e.pointerType === "touch") {
      const keep = { sel: { a: ed.sel.a, b: ed.sel.b }, cursor: ed.cursor };
      press = { x: e.clientX, y: e.clientY, pid: e.pointerId, timer: setTimeout(() => {
        const pr = press;
        press = null;
        clearInterval(autoTimer);
        ed.dragging = null;
        try { cv.releasePointerCapture(e.pointerId); } catch {}
        ed.sel = keep.sel;
        ed.cursor = keep.cursor;
        waveMenuAt(pr.x, pr.y, true, pr.pid, spec);
      }, 550) };
    }
    const f = tnSnap(Math.max(0, Math.min(ed.doc.frames, frameAt(p.x))), e.altKey);
    const selOn = ed.sel.b > ed.sel.a;
    const nearA = selOn && Math.abs(xOf(ed.sel.a) - p.x) < 6, nearB = selOn && Math.abs(xOf(ed.sel.b) - p.x) < 6;
    if (e.shiftKey) {
      const base = selOn ? (Math.abs(f - ed.sel.a) < Math.abs(f - ed.sel.b) ? ed.sel.b : ed.sel.a) : ed.cursor;
      ed.dragging = { mode: "new", anchor: base, x0: p.x, moved: true, free: e.altKey };
      dragTo(p.x);
    } else if (nearA || nearB) {
      ed.dragging = { mode: nearA ? "a" : "b", x0: p.x, moved: true, free: e.altKey };
    } else {
      ed.dragging = { mode: "new", anchor: f, x0: p.x, moved: false, free: e.altKey };
    }
    autoTimer = setInterval(auto, 30);
  });
  cv.addEventListener("pointermove", e => {
    if (!ed.doc) return;
    const p = local(e);
    if (pen.stroke) { penMove(e, cv); return; }
    if (px.drag) { pxMove(e, p); return; }
    if (press && Math.hypot(e.clientX - press.x, e.clientY - press.y) > 8) cancelPress();
    if (!ed.dragging) {
      if (spec && SPV.tool !== "time") return;
      if (!spec && pen.on) { cv.style.cursor = penReady() ? "crosshair" : "zoom-in"; return; }
      if (!spec) {
        const h = pxHit(p);
        if (h !== px.hover) { px.hover = h; redraw(); }
        if (h) { cv.style.cursor = "ew-resize"; return; }
      }
      const selOn = ed.sel.b > ed.sel.a;
      cv.style.cursor = selOn && (Math.abs(xOf(ed.sel.a) - p.x) < 6 || Math.abs(xOf(ed.sel.b) - p.x) < 6) ? "ew-resize" : "text";
      return;
    }
    lastX = p.x;
    ed.dragging.free = e.altKey;
    if (!ed.dragging.moved && Math.abs(p.x - ed.dragging.x0) < 3) return;
    ed.dragging.moved = true;
    dragTo(p.x);
  });
  const end = e => {
    cancelPress();
    if (pen.stroke) { if (e.type === "pointercancel") penCancel(); else penUp(); return; }
    if (px.drag) { if (e.type === "pointercancel") pxCancel(); else pxUp(); return; }
    if (!ed.dragging) return;
    clearInterval(autoTimer);
    const dg = ed.dragging;
    ed.dragging = null;
    if (!dg.moved) {
      ed.sel = { a: 0, b: 0 };
      ed.cursor = Math.round(dg.anchor);
      if (ed.play.on) startPlay(ed.cursor);
    } else {
      ed.sel.a = Math.round(ed.sel.a);
      ed.sel.b = Math.round(ed.sel.b);
      if (ed.sel.b <= ed.sel.a) ed.sel = { a: 0, b: 0 }; else ed.cursor = ed.sel.a;
    }
    redraw();
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  if (!spec) cv.addEventListener("pointerleave", () => { if (px.hover) { px.hover = null; redraw(); } });
  cv.addEventListener("contextmenu", e => {
    e.preventDefault();
    if (!ed.doc || !$("ctx").classList.contains("hidden")) return;
    pxCancel();
    if (ed.dragging) { clearInterval(autoTimer); ed.dragging = null; }
    waveMenuAt(e.clientX, e.clientY, false, undefined, spec);
  });
  cv.addEventListener("wheel", e => {
    if (!ed.doc) return;
    ctxClose();
    e.preventDefault();
    const p = local(e);
    const horizontal = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
    if (horizontal) {
      const d = e.deltaX || e.deltaY;
      ed.view.start += d * ed.view.spp;
      clampView();
      redraw();
    } else {
      const unit = e.deltaMode === 1 ? 33 : e.deltaMode === 2 ? 400 : 1;
      zoomAt(Math.exp(e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.002)), frameAt(p.x));
    }
  }, { passive: false });
}

function wireOverview() {
  const cv = $("ov");
  let drag = false;
  const go = e => {
    const r = cv.getBoundingClientRect();
    const f = (e.clientX - r.left) / r.width * ed.doc.frames;
    ed.view.start = f - viewWidth() * ed.view.spp / 2;
    clampView();
    redraw();
  };
  cv.addEventListener("pointerdown", e => { if (!ed.doc) return; drag = true; cv.setPointerCapture(e.pointerId); go(e); });
  cv.addEventListener("pointermove", e => { if (drag) go(e); });
  cv.addEventListener("pointerup", () => { drag = false; });
  cv.addEventListener("pointercancel", () => { drag = false; });
}

function wireRuler() {
  const cv = $("ru");
  let drag = null;
  const local = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const clampF = f => Math.round(Math.max(0, Math.min(ed.doc.frames, f)));
  const go = e => { ed.cursor = clampF(frameAt(local(e).x)); redraw(); };
  cv.addEventListener("pointerdown", e => {
    if (!ed.doc || e.button > 0) return;
    cv.setPointerCapture(e.pointerId);
    const p = local(e), hit = markAt(p.x, p.y);
    if (hit) {
      ed.markSel = hit.m.id;
      drag = { mark: hit, x0: p.x, moved: false };
      ed.markDrag = { id: hit.m.id, a: hit.m.a, b: hit.m.b };
      redraw();
      return;
    }
    drag = { cursor: true };
    go(e);
  });
  cv.addEventListener("pointermove", e => {
    if (!ed.doc) return;
    const p = local(e);
    if (!drag) { const h = markAt(p.x, p.y); cv.style.cursor = h ? (h.part === "move" ? "grab" : "ew-resize") : "pointer"; cv.title = h ? h.m.n + " · " + (h.m.name || "") : t("Click to place the cursor"); return; }
    if (drag.cursor) { go(e); return; }
    if (!drag.moved && Math.abs(p.x - drag.x0) < 3) return;
    drag.moved = true;
    const m = drag.mark.m, part = drag.mark.part, f = clampF(frameAt(p.x - drag.mark.grab));
    if (m.kind === "point") ed.markDrag = { id: m.id, a: f };
    else if (part === "a") ed.markDrag = { id: m.id, a: Math.min(f, m.b - 1), b: m.b };
    else if (part === "b") ed.markDrag = { id: m.id, a: m.a, b: Math.max(clampF(frameAt(p.x)), m.a + 1) };
    else { const len = m.b - m.a, a = Math.max(0, Math.min(ed.doc.frames - len, f)); ed.markDrag = { id: m.id, a, b: a + len }; }
    redraw();
  });
  const end = () => {
    if (!drag) return;
    const d = drag;
    drag = null;
    if (d.cursor) { if (ed.play.on) startPlay(ed.cursor); return; }
    const md = ed.markDrag;
    if (d.moved && md && (md.a !== d.mark.m.a || md.b !== d.mark.m.b)) { markEdit("markset", d.mark.m.id, d.mark.m.kind === "range" ? { a: md.a, b: md.b } : { a: md.a }); return; }
    ed.markDrag = null;
    recallMark(d.mark.m);
  };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("dblclick", e => { if (!ed.doc) return; const p = local(e), hit = markAt(p.x, p.y); if (hit) renameMark(hit.m); });
}

function ddInit(el, items, value, onChange) {
  const cur = el.querySelector(".cur"), list = el.querySelector(".list");
  const set = v => { const it = items.find(i => i.v === v) || items[0]; cur.textContent = t(it.label); el.dataset.v = it.v; };
  list.innerHTML = "";
  for (const it of items) {
    const d = document.createElement("div");
    d.className = "ddi";
    d.textContent = t(it.label);
    d.dataset.v = it.v;
    d.addEventListener("click", ev => { ev.stopPropagation(); el.classList.remove("open"); set(it.v); onChange(it.v); });
    list.appendChild(d);
  }
  cur.addEventListener("click", ev => { ev.stopPropagation(); document.querySelectorAll(".dd.open").forEach(o => { if (o !== el) o.classList.remove("open"); }); el.classList.toggle("open"); });
  set(value);
}

function typing(e) {
  const tg = e.target;
  return tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.isContentEditable || tg.closest("#dlg:not(.hidden)") || tg.closest(".lp"));
}

function toggleLoop() { ed.loop = !ed.loop; if (ed.play.on) startPlay(); redraw(); }
function cursorHome() { ed.cursor = 0; ensureVisible(0); if (ed.play.on) startPlay(0); redraw(); }
function cursorEnd() { ed.cursor = ed.doc.frames; ensureVisible(ed.doc.frames); stopPlay(); redraw(); }
function selectAll() { ed.sel = { a: 0, b: ed.doc.frames }; ed.cursor = 0; redraw(); }
function deselect() { ed.sel = { a: 0, b: 0 }; redraw(); }

function chanOnly(c) {
  const ch = ed.doc.channels;
  if (ch < 2) return;
  const only = ed.chans.every((v, i) => v === (i === c));
  ed.chans = only ? new Array(ch).fill(true) : ed.chans.map((_, i) => i === c);
  redraw();
}

function zoomToggle() {
  if (ed.zoomBack) { ed.view.start = ed.zoomBack.start; ed.view.spp = ed.zoomBack.spp; ed.zoomBack = null; clampView(); redraw(); return; }
  if (!selOn()) return;
  ed.zoomBack = { start: ed.view.start, spp: ed.view.spp };
  zoomSel();
}

async function adjustZero(mode) {
  if (!ed.doc || !selOn()) return;
  try {
    const r = await call({ t: "adjust", id: ed.doc.id, a: ed.sel.a, b: ed.sel.b, chans: ed.chans, mode });
    ed.sel = { a: r.a, b: r.b };
    ed.cursor = r.a;
    redraw();
  } catch (e) { editError(e); }
}

function scaleToggle() { ed.scale = ed.scale === "db" ? "lin" : "db"; localStorage.setItem("studioScale", ed.scale); redraw(); }
function colourToggle() { ed.colour = ed.colour === "spectral" ? "plain" : "spectral"; localStorage.setItem("studioColour", ed.colour); redraw(); }

function wireDrop() {
  let depth = 0;
  const has = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  window.addEventListener("dragenter", e => { if (!has(e) || $("app").classList.contains("hidden")) return; e.preventDefault(); if (ftIsOpen()) return; depth++; $("drop").classList.remove("hidden"); });
  window.addEventListener("dragover", e => { if (!has(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("dragleave", e => { if (!has(e)) return; depth = Math.max(0, depth - 1); if (!depth) $("drop").classList.add("hidden"); });
  window.addEventListener("drop", e => {
    if (!has(e)) return;
    e.preventDefault();
    depth = 0;
    $("drop").classList.add("hidden");
    if ($("app").classList.contains("hidden")) return;
    if (ftIsOpen()) { ftDrop(e.dataTransfer.files); return; }
    importFiles(e.dataTransfer.files);
  });
}

function wireUi() {
  $("fileIn").setAttribute("accept", AUDIO_ACCEPT);
  $("fileIn").addEventListener("change", e => { const f = e.target.files; importFiles(f); e.target.value = ""; });
  for (const id of ["openBtn", "openBtn2", "openBtn3"]) { const b = $(id); if (b) b.addEventListener("click", pickFiles); }
  $("filesBtn").addEventListener("click", ev => {
    ev.stopPropagation();
    if ($("files").classList.contains("hidden")) openFiles(); else closeFiles();
  });
  $("libBtn").addEventListener("click", ev => { ev.stopPropagation(); openFiles("library"); });
  $("lkBtn").addEventListener("click", ev => { ev.stopPropagation(); openFiles("locker"); });
  document.querySelectorAll("#files .ftab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
  let libTimer = 0;
  $("libQ").addEventListener("input", () => { clearTimeout(libTimer); libTimer = setTimeout(libSearch, 280); });
  $("libQ").addEventListener("keydown", e => { if (e.key === "Enter") { clearTimeout(libTimer); libSearch(); } if (e.key === "Escape") closeFiles(); });
  $("lkQ").addEventListener("input", renderLocker);
  $("lkQ").addEventListener("keydown", e => { if (e.key === "Escape") closeFiles(); });
  $("files").addEventListener("click", ev => ev.stopPropagation());
  $("hist").addEventListener("click", ev => ev.stopPropagation());
  $("histX").addEventListener("click", closeHist);
  $("locs").addEventListener("click", ev => ev.stopPropagation());
  $("locsX").addEventListener("click", closeLocs);
  $("locsAdd").addEventListener("click", () => addLocationDlg());
  document.addEventListener("click", () => { closeFiles(); closeHist(); closeLocs(); document.querySelectorAll(".dd.open").forEach(o => o.classList.remove("open")); });
  $("edTools").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-cmd]");
    if (!b || b.disabled) return;
    ev.stopPropagation();
    b.blur();
    runCmdById(b.dataset.cmd);
  });
  thWire();
  ddInit($("xfadeDd"), [{ v: "0", label: "Off" }, { v: "1", label: "1 ms" }, { v: "3", label: "3 ms" }, { v: "5", label: "5 ms" }, { v: "10", label: "10 ms" }, { v: "20", label: "20 ms" }], String(ed.xfade), v => { ed.xfade = Number(v); localStorage.setItem("studioXfade", v); });
  const snapSeg = () => document.querySelectorAll("#snapSeg button").forEach(b => b.classList.toggle("on", (b.dataset.v === "1") === ed.snap));
  $("snapSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; ed.snap = b.dataset.v === "1"; localStorage.setItem("studioSnap", ed.snap ? "1" : "0"); snapSeg(); });
  snapSeg();
  $("busyCancel").addEventListener("click", () => ed.worker.postMessage({ t: dj.job ? "sescancel" : "cancel" }));
  $("playBtn").addEventListener("click", togglePlay);
  $("stopBtn").addEventListener("click", () => stopPlay());
  $("homeBtn").addEventListener("click", () => { ed.cursor = 0; ensureVisible(0); if (ed.play.on) startPlay(0); redraw(); });
  $("loopBtn").addEventListener("click", () => { ed.loop = !ed.loop; if (ed.play.on) startPlay(); redraw(); });
  $("zinBtn").addEventListener("click", () => zoomAt(0.5));
  $("zoutBtn").addEventListener("click", () => zoomAt(2));
  $("zfitBtn").addEventListener("click", zoomFit);
  $("zselBtn").addEventListener("click", zoomSel);
  $("keysBtn").addEventListener("click", shortcuts);
  $("closeDocBtn").addEventListener("click", closeDoc);
  $("chanSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) setSelChannels(b.dataset.ch); });
  $("scaleSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; ed.scale = b.dataset.v; localStorage.setItem("studioScale", ed.scale); redraw(); });
  $("colourSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; ed.colour = b.dataset.v; localStorage.setItem("studioColour", ed.colour); redraw(); });
  $("mt").addEventListener("click", () => { ed.meter.clip = []; drawMeters(); });
  for (const id of ["selStart", "selEnd", "selDur"]) {
    const el = $(id);
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); applyPanel(id); el.blur(); } if (e.key === "Escape") { el.blur(); updatePanel(); } });
    el.addEventListener("change", () => applyPanel(id));
  }
  ddInit($("fmtDd"), [{ v: "time", label: "h:m:s.ms" }, { v: "samples", label: "samples" }, { v: "cd", label: "CD frames" }], ed.fmt, v => { ed.fmt = v; localStorage.setItem("studioFmt", v); if (ed.doc) updatePanel(); redraw(); });
  window.addEventListener("resize", () => { if (ed.doc) { clampView(); redraw(); drawMeters(); } });
  window.addEventListener("pagehide", () => saveView(true));
  wireWave($("wv"));
  wireWave($("sp"));
  wireSpec();
  wireOverview();
  wireRuler();
  wireCommands();
  wireExport();
  wireDiag();
  wireNr();
  wireHum();
  wireFx();
  wireScope();
  wireBatch();
  wireReport();
  wireNull();
  wireLoud();
  wireMidi();
  wireTracks();
  wirePx();
  wirePen();
  wireTn();
  wireSes();
  wireTags();
  wireAlbum();
  wireRec();
  wireTour();
  wireDrop();
}

async function editorStart() {
  if (ed.started) return;
  ed.started = true;
  wireUi();
  await refreshFiles();
  const last = localStorage.getItem("studioLastDoc"), lastSes = localStorage.getItem("studioLastSession");
  if (lastSes && !last) {
    try { await ssOpen(lastSes); } catch { try { localStorage.removeItem("studioLastSession"); } catch {} }
  } else if (last) {
    try {
      showOpened(await call({ t: "open", id: last }));
    } catch (e) {
      if (e && e.message === "locked") openError(e, "");
      else { try { localStorage.removeItem("studioLastDoc"); } catch {} }
    }
  }
  const q = new URLSearchParams(location.search), welcome = q.get("welcome") === "ext";
  if (q.has("rec") || q.has("welcome")) history.replaceState(null, "", location.pathname + location.hash);
  if (q.get("rec") === "1") recOpen();
  extInit().then(() => tourInit(welcome));
}

const BUCKET = 256;
const BPB = 256;
const RING = 1 << 17;
const DB_RANGE = 60;
const PALETTE = [[223, 57, 187], [223, 154, 36], [90, 193, 249]];
const PLAIN = "rgb(223,57,187)";
const AUDIO_ACCEPT = ".flac,.wav,.wave,.bwf,.aif,.aiff,.aifc,.mp3,.mp2,.m4a,.mp4,.aac,.alac,.caf,.ogg,.oga";

const ed = {
  worker: new Worker("/studio/worker.js"),
  req: 0,
  pending: new Map(),
  doc: null,
  levels: [],
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
  importing: null
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
  const sr = ed.doc ? ed.doc.sampleRate : 48000;
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

function buildLevels(meta, pk, bands) {
  const ch = meta.channels, n0 = Math.ceil(meta.frames / BUCKET), buckets = meta.slots * BPB;
  const min = [], max = [];
  for (let c = 0; c < ch; c++) {
    const mn = new Float32Array(n0), mx = new Float32Array(n0);
    const base = c * buckets * 2;
    for (let k = 0; k < n0; k++) { mn[k] = pk[base + k * 2]; mx[k] = pk[base + k * 2 + 1]; }
    min.push(mn); max.push(mx);
  }
  const levels = [{ size: BUCKET, n: n0, min, max, band: bands.slice(0, n0 * 3) }];
  while (levels[levels.length - 1].n > 1 && levels.length < 6) {
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

function amp(v) {
  if (ed.scale !== "db") return v;
  const a = Math.abs(v);
  if (a < 1e-9) return 0;
  const n = 1 + 20 * Math.log10(a) / DB_RANGE;
  return n <= 0 ? 0 : (v < 0 ? -n : n);
}

function colourOf(l, m, h) {
  if (ed.colour !== "spectral") return PLAIN;
  const w0 = l, w1 = m * 1.4, w2 = h * 2.6, s = w0 + w1 + w2;
  if (!(s > 1e-9)) return PLAIN;
  const r = (PALETTE[0][0] * w0 + PALETTE[1][0] * w1 + PALETTE[2][0] * w2) / s;
  const g = (PALETTE[0][1] * w0 + PALETTE[1][1] * w1 + PALETTE[2][1] * w2) / s;
  const b = (PALETTE[0][2] * w0 + PALETTE[1][2] * w1 + PALETTE[2][2] * w2) / s;
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
  drawOverview();
  drawRuler();
  drawWave();
  updatePanel();
  saveView();
}

function columnPeaks(level, s0, s1, c) {
  const L = ed.levels[level];
  const i0 = Math.max(0, Math.floor(s0 / L.size)), i1 = Math.min(L.n, Math.max(i0 + 1, Math.ceil(s1 / L.size)));
  let mn = Infinity, mx = -Infinity;
  const a = L.min[c], b = L.max[c];
  for (let i = i0; i < i1; i++) { if (a[i] < mn) mn = a[i]; if (b[i] > mx) mx = b[i]; }
  return i1 > i0 ? [mn, mx, i0, i1] : null;
}

function columnBand(level, i0, i1) {
  const band = ed.levels[level].band;
  let l = 0, m = 0, h = 0;
  for (let i = i0; i < i1; i++) { l += band[i * 3]; m += band[i * 3 + 1]; h += band[i * 3 + 2]; }
  return colourOf(l, m, h);
}

function levelFor(sppDev) {
  let lv = 0;
  for (let i = 0; i < ed.levels.length; i++) if (ed.levels[i].size <= sppDev) lv = i;
  return lv;
}

function rawCovers(a, b) {
  const r = ed.raw;
  return r && r.id === ed.doc.id && a >= r.start && b <= r.start + r.count;
}

function wantRaw(a, b) {
  const span = b - a;
  const start = Math.max(0, Math.floor(a - span * 0.5)), end = Math.min(ed.doc.frames, Math.ceil(b + span * 0.5));
  ed.rawWant = { id: ed.doc.id, start, count: end - start };
  pumpRaw();
}

async function pumpRaw() {
  if (ed.rawBusy || !ed.rawWant) return;
  const w = ed.rawWant;
  ed.rawWant = null;
  ed.rawBusy = true;
  try {
    const r = await call({ t: "read", id: w.id, start: w.start, count: w.count });
    if (ed.doc && r.id === ed.doc.id && r.count) {
      ed.raw = { id: r.id, start: r.start, count: r.count, data: r.data };
      redraw();
    }
  } catch {}
  ed.rawBusy = false;
  if (ed.rawWant) pumpRaw();
}

function drawWave() {
  const cv = $("wv"), dpr = canvasFit(cv), g = cv.getContext("2d");
  const key = [cv.width, cv.height, ed.view.start, ed.view.spp, ed.sel.a, ed.sel.b, ed.cursor, ed.scale, ed.colour, ed.chans.join(), ed.raw ? ed.raw.id + ed.raw.start + ":" + ed.raw.count : "", ed.doc.id].join("|");
  if (!ed.waveBuf) ed.waveBuf = document.createElement("canvas");
  if (key !== ed.waveKey) {
    ed.waveBuf.width = cv.width;
    ed.waveBuf.height = cv.height;
    drawWaveBase(ed.waveBuf.getContext("2d"), cv.width, cv.height, dpr);
    ed.waveKey = key;
  }
  g.drawImage(ed.waveBuf, 0, 0);
  if (ed.play.on) {
    const px = Math.round(xOf(playhead()) * dpr);
    if (px >= 0 && px <= cv.width) { g.fillStyle = "#f2efe9"; g.fillRect(px, 0, Math.max(1, dpr), cv.height); }
  }
}

function drawWaveBase(g, W, H, dpr) {
  const doc = ed.doc, ch = doc.channels;
  const laneH = H / ch, sppD = ed.view.spp / dpr, start = ed.view.start;
  g.fillStyle = "#0e0c0a";
  g.fillRect(0, 0, W, H);
  const selOn = ed.sel.b > ed.sel.a;
  const sx0 = Math.max(0, Math.floor(xOf(ed.sel.a) * dpr)), sx1 = Math.min(W, Math.ceil(xOf(ed.sel.b) * dpr));
  for (let c = 0; c < ch; c++) {
    const top = c * laneH, mid = top + laneH / 2, A = laneH / 2 - 3 * dpr;
    g.fillStyle = c % 2 ? "#110f0c" : "#13110e";
    g.fillRect(0, top, W, laneH);
    if (selOn && ed.chans[c]) { g.fillStyle = "rgba(255,255,255,0.09)"; g.fillRect(sx0, top, Math.max(1, sx1 - sx0), laneH); }
    g.fillStyle = "rgba(255,255,255,0.07)";
    for (const lv of [0.5, -0.5]) { const y = mid - amp(lv) * A; g.fillRect(0, Math.round(y), W, 1); }
    g.fillStyle = "rgba(255,255,255,0.16)";
    g.fillRect(0, Math.round(mid), W, 1);
    const visA = start, visB = start + W * sppD;
    const useRaw = sppD < BUCKET;
    if (useRaw && !rawCovers(Math.floor(visA), Math.ceil(visB))) wantRaw(visA, visB);
    const raw = useRaw && rawCovers(Math.floor(visA), Math.min(doc.frames, Math.ceil(visB))) ? ed.raw : null;
    if (raw && sppD < 1) {
      const d = raw.data, base = c * raw.count;
      const i0 = Math.max(0, Math.floor(visA) - 1), i1 = Math.min(doc.frames - 1, Math.ceil(visB) + 1);
      const lvl0 = ed.levels[0].band;
      const k = Math.floor((i0 + i1) / 2 / BUCKET);
      g.strokeStyle = colourOf(lvl0[k * 3] || 0, lvl0[k * 3 + 1] || 0, lvl0[k * 3 + 2] || 0);
      g.lineWidth = Math.max(1, dpr * 1.2);
      g.beginPath();
      for (let i = i0; i <= i1; i++) {
        const x = (i - start) / sppD, y = mid - amp(d[base + i - raw.start]) * A;
        if (i === i0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.stroke();
      if (1 / sppD >= 6) {
        g.fillStyle = g.strokeStyle;
        for (let i = i0; i <= i1; i++) {
          const x = (i - start) / sppD, y = mid - amp(d[base + i - raw.start]) * A;
          g.fillRect(x - 1.5 * dpr, y - 1.5 * dpr, 3 * dpr, 3 * dpr);
        }
      }
      continue;
    }
    const lv = levelFor(sppD);
    for (let x = 0; x < W; x++) {
      const s0 = start + x * sppD, s1 = s0 + sppD;
      if (s0 >= doc.frames) break;
      let mn, mx, col;
      if (raw) {
        const d = raw.data, base = c * raw.count;
        const a = Math.max(raw.start, Math.floor(s0)), b = Math.min(raw.start + raw.count, Math.max(a + 1, Math.ceil(s1)));
        mn = Infinity; mx = -Infinity;
        for (let i = a; i < b; i++) { const v = d[base + i - raw.start]; if (v < mn) mn = v; if (v > mx) mx = v; }
        const k = Math.floor(s0 / BUCKET), band = ed.levels[0].band;
        col = colourOf(band[k * 3] || 0, band[k * 3 + 1] || 0, band[k * 3 + 2] || 0);
      } else {
        const p = columnPeaks(lv, s0, s1, c);
        if (!p) continue;
        mn = p[0]; mx = p[1];
        col = columnBand(lv, p[2], p[3]);
      }
      let y0 = mid - amp(mx) * A, y1 = mid - amp(mn) * A;
      if (y1 - y0 < 1) { const ym = (y0 + y1) / 2; y0 = ym - 0.5; y1 = ym + 0.5; }
      g.fillStyle = col;
      g.fillRect(x, y0, 1, y1 - y0);
    }
  }
  g.fillStyle = "rgba(255,255,255,0.12)";
  for (let c = 1; c < ch; c++) g.fillRect(0, Math.round(c * laneH), W, 1);
  drawAmpLabels(g, W, laneH, ch, dpr);
  const cx = Math.round(xOf(ed.cursor) * dpr);
  if (cx >= 0 && cx <= W) { g.fillStyle = "#DF9A24"; g.fillRect(cx, 0, Math.max(1, dpr), H); }
}

function drawAmpLabels(g, W, laneH, ch, dpr) {
  g.font = (9 * dpr) + "px JetBrains Mono, monospace";
  g.textAlign = "right";
  g.textBaseline = "middle";
  const marks = ed.scale === "db" ? [0, -6, -12, -24, -48] : [0, -6, -12, -18];
  for (let c = 0; c < ch; c++) {
    const top = c * laneH, mid = top + laneH / 2, A = laneH / 2 - 3 * dpr;
    for (const db of marks) {
      const v = Math.pow(10, db / 20), y = mid - amp(v) * A;
      if (y < top + 6 * dpr) continue;
      g.fillStyle = "rgba(10,9,8,0.7)";
      g.fillRect(W - 30 * dpr, y - 5 * dpr, 30 * dpr, 10 * dpr);
      g.fillStyle = "#7d776e";
      g.fillText(db === 0 ? "0" : String(db), W - 4 * dpr, y);
    }
    if (ch > 1) {
      g.textAlign = "left";
      g.fillStyle = ed.chans[c] ? "#c9c3b9" : "#5f5a52";
      g.fillText(chanName(c, ch), 6 * dpr, top + 9 * dpr);
      g.textAlign = "right";
    }
  }
}

function chanName(c, ch) {
  if (ch === 2) return c === 0 ? "L" : "R";
  return String(c + 1);
}

function tickStep(sppCss) {
  const sr = ed.doc.sampleRate, minPx = 90;
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

function drawRuler() {
  const cv = $("ru"), dpr = canvasFit(cv), g = cv.getContext("2d");
  const W = cv.width, H = cv.height;
  g.fillStyle = "#12100e";
  g.fillRect(0, 0, W, H);
  if (ed.sel.b > ed.sel.a) {
    const a = xOf(ed.sel.a) * dpr, b = xOf(ed.sel.b) * dpr;
    g.fillStyle = "rgba(223,154,36,0.22)";
    g.fillRect(a, 0, Math.max(1, b - a), H);
  }
  const st = tickStep(ed.view.spp);
  const startF = ed.view.start, endF = startF + cv.clientWidth * ed.view.spp;
  g.fillStyle = "#3a352f";
  for (let f = Math.ceil(startF / st.minor) * st.minor; f <= endF; f += st.minor) g.fillRect(Math.round(xOf(f) * dpr), H - 5 * dpr, Math.max(1, dpr), 5 * dpr);
  g.font = (9.5 * dpr) + "px JetBrains Mono, monospace";
  g.textBaseline = "top";
  g.textAlign = "left";
  for (let f = Math.ceil(startF / st.major) * st.major; f <= endF; f += st.major) {
    const x = Math.round(xOf(f) * dpr);
    g.fillStyle = "#6f695f";
    g.fillRect(x, H - 10 * dpr, Math.max(1, dpr), 10 * dpr);
    g.fillStyle = "#a39d93";
    g.fillText(fmtTime(f, ed.fmt, st.sec), x + 3 * dpr, 3 * dpr);
  }
  g.fillStyle = "#2a2520";
  g.fillRect(0, H - dpr, W, dpr);
  const cx = xOf(ed.cursor) * dpr;
  g.fillStyle = "#DF9A24";
  g.beginPath(); g.moveTo(cx - 5 * dpr, 0); g.lineTo(cx + 5 * dpr, 0); g.lineTo(cx, 7 * dpr); g.fill();
}

function drawOverview() {
  const cv = $("ov"), dpr = canvasFit(cv), g = cv.getContext("2d");
  const key = [cv.width, cv.height, ed.view.start, ed.view.spp, ed.sel.a, ed.sel.b, ed.cursor, ed.scale, ed.colour, ed.doc.id].join("|");
  if (!ed.ovBuf) ed.ovBuf = document.createElement("canvas");
  if (key !== ed.ovKey) {
    ed.ovBuf.width = cv.width;
    ed.ovBuf.height = cv.height;
    drawOverviewBase(ed.ovBuf.getContext("2d"), cv.width, cv.height, dpr);
    ed.ovKey = key;
  }
  g.drawImage(ed.ovBuf, 0, 0);
  if (ed.play.on) { g.fillStyle = "#f2efe9"; g.fillRect(Math.round(playhead() / (ed.doc.frames / cv.width)), 0, dpr, cv.height); }
}

function drawOverviewBase(g, W, H, dpr) {
  const doc = ed.doc, ch = doc.channels;
  g.fillStyle = "#0e0c0a";
  g.fillRect(0, 0, W, H);
  const sppD = doc.frames / W, lv = levelFor(sppD), mid = H / 2, A = H / 2 - 2 * dpr;
  for (let x = 0; x < W; x++) {
    const s0 = x * sppD, s1 = s0 + sppD;
    let mn = Infinity, mx = -Infinity, i0 = 0, i1 = 0;
    for (let c = 0; c < ch; c++) {
      const p = columnPeaks(lv, s0, s1, c);
      if (!p) continue;
      if (p[0] < mn) mn = p[0];
      if (p[1] > mx) mx = p[1];
      i0 = p[2]; i1 = p[3];
    }
    if (mx === -Infinity) continue;
    g.fillStyle = columnBand(lv, i0, i1);
    g.globalAlpha = 0.75;
    const y0 = mid - Math.abs(amp(mx)) * A, y1 = mid + Math.abs(amp(mn)) * A;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
  g.globalAlpha = 1;
  const vx = ed.view.start / sppD, vw = Math.max(2 * dpr, viewWidth() * ed.view.spp / sppD);
  g.fillStyle = "rgba(255,255,255,0.10)";
  g.fillRect(vx, 0, vw, H);
  g.strokeStyle = "rgba(242,239,233,0.55)";
  g.lineWidth = dpr;
  g.strokeRect(vx + dpr / 2, dpr / 2, vw - dpr, H - dpr);
  if (ed.sel.b > ed.sel.a) { g.fillStyle = "rgba(223,154,36,0.25)"; g.fillRect(ed.sel.a / sppD, 0, Math.max(dpr, (ed.sel.b - ed.sel.a) / sppD), H); }
  g.fillStyle = "#DF9A24";
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

function showDoc(meta, peaks, bands) {
  stopPlay();
  ed.doc = meta;
  ed.levels = buildLevels(meta, peaks, bands);
  ed.raw = null;
  ed.rawWant = null;
  ed.chans = new Array(meta.channels).fill(true);
  ed.sel = { a: 0, b: 0 };
  ed.cursor = 0;
  $("empty").classList.add("hidden");
  $("ed").classList.remove("hidden");
  $("docName").textContent = meta.name;
  $("docName").title = meta.name;
  const chs = meta.channels === 1 ? t("mono") : meta.channels === 2 ? t("stereo") : meta.channels + " ch";
  $("docInfo").textContent = [(meta.sampleRate / 1000).toLocaleString() + " kHz", meta.bits ? meta.bits + "-bit" : (meta.ext || "").toUpperCase(), chs, fmtDur(meta.frames / meta.sampleRate)].join(" · ");
  chanSeg();
  ed.view.spp = meta.frames / viewWidth();
  ed.view.start = 0;
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem("studioView:" + meta.id) || "null"); } catch {}
  if (saved) {
    if (Number.isFinite(saved.spp)) ed.view.spp = saved.spp;
    if (Number.isFinite(saved.start)) ed.view.start = saved.start;
    if (Number.isFinite(saved.cursor)) ed.cursor = Math.min(meta.frames, Math.max(0, saved.cursor));
    if (Number.isFinite(saved.a) && Number.isFinite(saved.b) && saved.b <= meta.frames) ed.sel = { a: saved.a, b: saved.b };
    if (Array.isArray(saved.chans) && saved.chans.length === meta.channels && saved.chans.some(Boolean)) ed.chans = saved.chans;
  }
  clampView();
  try { localStorage.setItem("studioLastDoc", meta.id); } catch {}
  ed.meter = { pk: [], rms: [], hold: [], holdT: [], clip: [], t: 0 };
  drawMeters();
  redraw();
  closeFiles();
}

function closeDoc() {
  stopPlay();
  ed.doc = null;
  ed.levels = [];
  ed.raw = null;
  $("ed").classList.add("hidden");
  $("empty").classList.remove("hidden");
  try { localStorage.removeItem("studioLastDoc"); } catch {}
  call({ t: "close" }).catch(() => {});
  refreshFiles();
}

async function openDoc(id) {
  try {
    const r = await call({ t: "open", id });
    showDoc(r.meta, r.peaks, r.bands);
  } catch (e) { openError(e, ""); }
}

function openError(e, name) {
  const msg = e && e.message === "locked" ? t("This file is open in another Studio tab.") : e && e.message === "quota" ? t("Browser storage is full. Remove files from Studio's list to make room.") : e && e.message === "cancelled" ? "" : (e && e.message) || String(e);
  if (!msg) return;
  tell((name ? name + ": " : "") + msg, t("Could not open the file"));
}

async function importFiles(files) {
  const list = [...files].filter(f => f && f.size > 0);
  if (!list.length) return;
  for (const f of list) {
    ed.importing = { name: f.name, frac: 0 };
    importProgress({ name: f.name, frac: 0 });
    try {
      const r = await call({ t: "import", file: f });
      showDoc(r.meta, r.peaks, r.bands);
    } catch (e) { openError(e, f.name); }
  }
  ed.importing = null;
  $("busy").classList.add("hidden");
  refreshFiles();
  call({ t: "persist" }).catch(() => {});
}

function importProgress(m) {
  const box = $("busy");
  box.classList.remove("hidden");
  $("busyName").textContent = m.name;
  $("busyBar").style.width = Math.round((m.frac || 0) * 100) + "%";
  $("busyPct").textContent = Math.round((m.frac || 0) * 100) + "%";
}

function closeFiles() { $("files").classList.add("hidden"); }

async function refreshFiles() {
  let r;
  try { r = await call({ t: "list" }); } catch { return; }
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
      name.querySelector(".fi").textContent = [fmtDur(d.frames / d.sampleRate), (d.sampleRate / 1000) + " kHz", d.bits ? d.bits + "-bit" : (d.ext || "").toUpperCase(), d.channels === 1 ? t("mono") : d.channels === 2 ? t("stereo") : d.channels + " ch", fmtBytes(d.frames * d.channels * 4)].join(" · ");
      name.addEventListener("click", () => openDoc(d.id));
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
        } catch (e) { tell(String(e.message || e)); }
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

async function ensureAudio() {
  const doc = ed.doc;
  if (ed.ctx && ed.ctx.sampleRate === doc.sampleRate && ed.node && ed.nodeCh === doc.channels) {
    if (ed.ctx.state !== "running") await ed.ctx.resume();
    return;
  }
  if (ed.ctx) { try { await ed.ctx.close(); } catch {} }
  let ctx;
  try { ctx = new AudioContext({ sampleRate: doc.sampleRate, latencyHint: "interactive" }); }
  catch { ctx = new AudioContext({ latencyHint: "interactive" }); }
  await ctx.audioWorklet.addModule("/studio/player-worklet.js");
  const data = new SharedArrayBuffer(RING * doc.channels * 4), ctrl = new SharedArrayBuffer(8 * 4);
  const node = new AudioWorkletNode(ctx, "studio-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [doc.channels], processorOptions: { data, ctrl, size: RING, channels: doc.channels } });
  node.port.onmessage = e => meterIn(e.data);
  node.connect(ctx.destination);
  ed.ctx = ctx;
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
  const cv = $("mt"), dpr = canvasFit(cv), g = cv.getContext("2d");
  const W = cv.width, H = cv.height, M = ed.meter, now = performance.now();
  const ch = ed.doc ? ed.doc.channels : 2;
  const dt = M.t ? (now - M.t) / 1000 : 0;
  M.t = now;
  g.fillStyle = "#0e0c0a";
  g.fillRect(0, 0, W, H);
  const clipW = 14 * dpr, barW = W - clipW - 4 * dpr, scaleH = 11 * dpr;
  const rowH = Math.max(3 * dpr, (H - scaleH - (ch + 1) * 2 * dpr) / ch);
  const xOfDb = db => Math.max(0, Math.min(1, (db + 60) / 60)) * barW;
  let active = false;
  for (let c = 0; c < ch; c++) {
    const y = 2 * dpr + c * (rowH + 2 * dpr);
    g.fillStyle = "#1a1710";
    g.fillRect(0, y, barW, rowH);
    let pk = M.pk[c] ?? -120;
    if (!ed.play.on) pk -= 30 * dt;
    pk = Math.max(-120, pk - 20 * dt);
    M.pk[c] = pk;
    if (pk > -60) active = true;
    const rms = ed.play.on ? (M.rms[c] ?? -120) : -120;
    const grad = g.createLinearGradient(0, 0, barW, 0);
    grad.addColorStop(0, "#5AC1F9");
    grad.addColorStop(xOfDb(-18) / barW, "#5AC1F9");
    grad.addColorStop(xOfDb(-12) / barW, "#DF9A24");
    grad.addColorStop(xOfDb(-3) / barW, "#DF39BB");
    grad.addColorStop(1, "#ff3b30");
    g.globalAlpha = 0.45;
    g.fillStyle = grad;
    g.fillRect(0, y, xOfDb(pk), rowH);
    g.globalAlpha = 1;
    g.fillRect(0, y + rowH * 0.25, xOfDb(rms), rowH * 0.5);
    const hold = M.hold[c] ?? -120;
    if (hold > -60 && now - (M.holdT[c] || 0) < 3000) { g.fillStyle = "#f2efe9"; g.fillRect(xOfDb(hold) - dpr, y, 2 * dpr, rowH); active = true; }
    g.fillStyle = M.clip[c] ? "#ff3b30" : "#231f18";
    g.fillRect(W - clipW, y, clipW, rowH);
  }
  g.font = (8.5 * dpr) + "px JetBrains Mono, monospace";
  g.textBaseline = "bottom";
  g.textAlign = "center";
  g.fillStyle = "#6f695f";
  for (const db of [-60, -48, -36, -24, -18, -12, -6, -3, 0]) {
    const x = xOfDb(db);
    g.fillRect(x, H - scaleH, Math.max(1, dpr), 3 * dpr);
    g.fillText(db === 0 ? "0" : String(db), Math.min(Math.max(x, 8 * dpr), barW - 4 * dpr), H);
  }
  if (active || ed.play.on) ed.meterRaf = requestAnimationFrame(drawMeters);
}

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

function wireWave() {
  const cv = $("wv");
  let autoTimer = 0, lastX = 0;
  const local = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width }; };
  const auto = () => {
    if (!ed.dragging) return;
    const W = viewWidth();
    let d = 0;
    if (lastX < 0) d = lastX; else if (lastX > W) d = lastX - W;
    if (d) { ed.view.start += d * ed.view.spp * 0.5; clampView(); dragTo(lastX); }
  };
  const dragTo = x => {
    const f = Math.max(0, Math.min(ed.doc.frames, frameAt(Math.max(0, Math.min(viewWidth(), x)))));
    const dg = ed.dragging;
    if (dg.mode === "a") { ed.sel.a = f; if (ed.sel.a > ed.sel.b) { [ed.sel.a, ed.sel.b] = [ed.sel.b, ed.sel.a]; dg.mode = "b"; } }
    else if (dg.mode === "b") { ed.sel.b = f; if (ed.sel.b < ed.sel.a) { [ed.sel.a, ed.sel.b] = [ed.sel.b, ed.sel.a]; dg.mode = "a"; } }
    else { ed.sel = { a: Math.min(dg.anchor, f), b: Math.max(dg.anchor, f) }; }
    redraw();
  };
  cv.addEventListener("pointerdown", e => {
    if (!ed.doc || e.button > 0) return;
    e.preventDefault();
    cv.setPointerCapture(e.pointerId);
    const p = local(e);
    lastX = p.x;
    const f = Math.max(0, Math.min(ed.doc.frames, frameAt(p.x)));
    const selOn = ed.sel.b > ed.sel.a;
    const nearA = selOn && Math.abs(xOf(ed.sel.a) - p.x) < 6, nearB = selOn && Math.abs(xOf(ed.sel.b) - p.x) < 6;
    if (e.shiftKey) {
      const base = selOn ? (Math.abs(f - ed.sel.a) < Math.abs(f - ed.sel.b) ? ed.sel.b : ed.sel.a) : ed.cursor;
      ed.dragging = { mode: "new", anchor: base, x0: p.x, moved: true };
      dragTo(p.x);
    } else if (nearA || nearB) {
      ed.dragging = { mode: nearA ? "a" : "b", x0: p.x, moved: true };
    } else {
      ed.dragging = { mode: "new", anchor: f, x0: p.x, moved: false };
    }
    autoTimer = setInterval(auto, 30);
  });
  cv.addEventListener("pointermove", e => {
    if (!ed.doc) return;
    const p = local(e);
    if (!ed.dragging) {
      const selOn = ed.sel.b > ed.sel.a;
      cv.style.cursor = selOn && (Math.abs(xOf(ed.sel.a) - p.x) < 6 || Math.abs(xOf(ed.sel.b) - p.x) < 6) ? "ew-resize" : "text";
      return;
    }
    lastX = p.x;
    if (!ed.dragging.moved && Math.abs(p.x - ed.dragging.x0) < 3) return;
    ed.dragging.moved = true;
    dragTo(p.x);
  });
  const end = e => {
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
  cv.addEventListener("wheel", e => {
    if (!ed.doc) return;
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
  let drag = false;
  const go = e => {
    const r = cv.getBoundingClientRect();
    ed.cursor = Math.round(Math.max(0, Math.min(ed.doc.frames, frameAt(e.clientX - r.left))));
    redraw();
  };
  cv.addEventListener("pointerdown", e => { if (!ed.doc) return; drag = true; cv.setPointerCapture(e.pointerId); go(e); });
  cv.addEventListener("pointermove", e => { if (drag) go(e); });
  const end = () => { if (!drag) return; drag = false; if (ed.play.on) startPlay(ed.cursor); };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
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

function shortcuts() {
  const rows = [
    ["Space", t("Play / stop")],
    ["L", t("Loop on / off")],
    ["Home / End", t("Cursor to start / end")],
    ["= / −", t("Zoom in / out")],
    ["\\", t("Zoom to the whole file")],
    ["Z", t("Zoom to the selection")],
    ["Ctrl/⌘ A", t("Select all")],
    ["Esc", t("Clear the selection")],
    ["Ctrl/⌘ O", t("Open a file")],
    ["Shift + " + t("click"), t("Extend the selection")],
    [t("Wheel"), t("Zoom · Shift+wheel scrolls")],
    ["?", t("This list")]
  ];
  askForm(t("Keyboard shortcuts"), `<div class="keys">${rows.map(r => `<div><kbd>${esc(r[0])}</kbd><span>${esc(r[1])}</span></div>`).join("")}</div>`, { ok: t("close") });
  const c = document.querySelector("#dlg .dcancel");
  if (c) c.style.display = "none";
}

function typing(e) {
  const tg = e.target;
  return tg && (tg.tagName === "INPUT" || tg.tagName === "TEXTAREA" || tg.isContentEditable || tg.closest("#dlg:not(.hidden)") || tg.closest(".lp"));
}

function wireKeys() {
  document.addEventListener("keydown", e => {
    const modal = $("dlg") && !$("dlg").classList.contains("hidden");
    if (typing(e) || modal) return;
    if (!$("app") || $("app").classList.contains("hidden")) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === "o" || e.key === "O")) { e.preventDefault(); pickFiles(); return; }
    if (e.key === "?") { e.preventDefault(); shortcuts(); return; }
    if (!ed.doc) return;
    if (e.key === " " && !mod) { e.preventDefault(); togglePlay(); return; }
    if (mod && (e.key === "a" || e.key === "A")) { e.preventDefault(); ed.sel = { a: 0, b: ed.doc.frames }; ed.cursor = 0; redraw(); return; }
    if (mod) return;
    if (e.key === "Escape") { if (!$("files").classList.contains("hidden")) { closeFiles(); return; } ed.sel = { a: 0, b: 0 }; redraw(); return; }
    if (e.key === "Home") { e.preventDefault(); ed.cursor = 0; ensureVisible(0); if (ed.play.on) startPlay(0); redraw(); return; }
    if (e.key === "End") { e.preventDefault(); ed.cursor = ed.doc.frames; ensureVisible(ed.doc.frames); stopPlay(); redraw(); return; }
    if (e.key === "=" || e.key === "+") { e.preventDefault(); zoomAt(0.5); return; }
    if (e.key === "-" || e.key === "_") { e.preventDefault(); zoomAt(2); return; }
    if (e.key === "\\") { e.preventDefault(); zoomFit(); return; }
    if (e.key === "z" || e.key === "Z") { e.preventDefault(); zoomSel(); return; }
    if (e.key === "l" || e.key === "L") { e.preventDefault(); ed.loop = !ed.loop; if (ed.play.on) startPlay(); redraw(); return; }
  });
}

function wireDrop() {
  let depth = 0;
  const has = e => e.dataTransfer && [...e.dataTransfer.types].includes("Files");
  window.addEventListener("dragenter", e => { if (!has(e) || $("app").classList.contains("hidden")) return; e.preventDefault(); depth++; $("drop").classList.remove("hidden"); });
  window.addEventListener("dragover", e => { if (!has(e)) return; e.preventDefault(); e.dataTransfer.dropEffect = "copy"; });
  window.addEventListener("dragleave", e => { if (!has(e)) return; depth = Math.max(0, depth - 1); if (!depth) $("drop").classList.add("hidden"); });
  window.addEventListener("drop", e => {
    if (!has(e)) return;
    e.preventDefault();
    depth = 0;
    $("drop").classList.add("hidden");
    if ($("app").classList.contains("hidden")) return;
    importFiles(e.dataTransfer.files);
  });
}

function wireUi() {
  $("fileIn").setAttribute("accept", AUDIO_ACCEPT);
  $("fileIn").addEventListener("change", e => { const f = e.target.files; importFiles(f); e.target.value = ""; });
  for (const id of ["openBtn", "openBtn2", "openBtn3"]) { const b = $(id); if (b) b.addEventListener("click", pickFiles); }
  $("filesBtn").addEventListener("click", ev => {
    ev.stopPropagation();
    const box = $("files");
    const open = box.classList.contains("hidden");
    box.classList.toggle("hidden", !open);
    if (open) refreshFiles();
  });
  $("files").addEventListener("click", ev => ev.stopPropagation());
  document.addEventListener("click", () => { closeFiles(); document.querySelectorAll(".dd.open").forEach(o => o.classList.remove("open")); });
  $("busyCancel").addEventListener("click", () => ed.worker.postMessage({ t: "cancel" }));
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
  wireWave();
  wireOverview();
  wireRuler();
  wireKeys();
  wireDrop();
}

async function editorStart() {
  if (ed.started) return;
  ed.started = true;
  wireUi();
  await refreshFiles();
  const last = localStorage.getItem("studioLastDoc");
  if (last) {
    try {
      const r = await call({ t: "open", id: last });
      showDoc(r.meta, r.peaks, r.bands);
    } catch { try { localStorage.removeItem("studioLastDoc"); } catch {} }
  }
}

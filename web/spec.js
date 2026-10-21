const SP_TILE = 128;
const SP_MAX = 120;
const SP_BG = "#0c0a09";

function spStored(key, def, ok) {
  try { const v = localStorage.getItem(key); return v !== null && ok(v) ? v : def; } catch { return def; }
}

const SPV = {
  on: spStored("studioSpec", "0", v => v === "0" || v === "1") === "1",
  split: Number(spStored("studioSpecSplit", "0.42", v => Number.isFinite(Number(v)) && Number(v) >= 0 && Number(v) <= 0.9)),
  log: spStored("studioSpecScale", "log", v => v === "log" || v === "lin") === "log",
  res: spStored("studioSpecRes", "auto", v => v === "auto" || [512, 1024, 2048, 4096, 8192, 16384].includes(Number(v))),
  range: Number(spStored("studioSpecRange", "120", v => [80, 100, 120, 140, 160].includes(Number(v)))),
  tiles: new Map(),
  want: new Set(),
  gen: 0,
  use: 0,
  tver: 0,
  layers: [null, null],
  lv: null,
  lkey: "",
  bkey: "",
  buf: null,
  hover: null,
  err: "",
  tool: spStored("studioSpecTool", "time", v => ["time", "rect", "lasso", "brush"].includes(v)),
  brush: Number(spStored("studioSpecBrush", "24", v => Number(v) >= 4 && Number(v) <= 120)),
  sel: null,
  sver: 0,
  draft: null
};

const SP_LUT = (() => {
  const st = [[0, 8, 7, 7], [0.2, 24, 12, 38], [0.38, 64, 18, 92], [0.52, 130, 30, 140], [0.64, 200, 50, 170], [0.74, 232, 74, 150], [0.84, 235, 140, 50], [0.93, 245, 200, 90], [1, 255, 246, 220]];
  const lut = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    const u = i / 255;
    let j = 1;
    while (j < st.length - 1 && st[j][0] < u) j++;
    const a = st[j - 1], b = st[j], w = (u - a[0]) / (b[0] - a[0]);
    const r = Math.round(a[1] + (b[1] - a[1]) * w), g = Math.round(a[2] + (b[2] - a[2]) * w), bl = Math.round(a[3] + (b[3] - a[3]) * w);
    lut[i] = ((255 << 24) | (bl << 16) | (g << 8) | r) >>> 0;
  }
  return lut;
})();

function spSave(key, v) { try { localStorage.setItem(key, String(v)); } catch {} }

function spN() {
  if (SPV.res !== "auto") return Number(SPV.res);
  const sr = ed.doc ? ed.doc.sampleRate : 48000;
  return sr <= 50000 ? 2048 : sr <= 100000 ? 4096 : 8192;
}

function spLo(n, sr) { return SPV.log ? Math.max(20, sr / n) : 0; }

function spU(f, n, sr) {
  const nyq = sr / 2;
  if (!SPV.log) return f / nyq;
  const lo = spLo(n, sr);
  return Math.log(f / lo) / Math.log(nyq / lo);
}

function spF(u, n, sr) {
  const nyq = sr / 2;
  if (!SPV.log) return nyq * u;
  const lo = spLo(n, sr);
  return lo * Math.pow(nyq / lo, u);
}

function spHz(f) {
  if (f < 1000) return (f < 100 ? f.toFixed(1) : String(Math.round(f))) + " Hz";
  return (f / 1000).toFixed(f < 10000 ? 2 : 1) + " kHz";
}

function spLayout() {
  const wv = $("wv"), sp = $("sp"), bar = $("spSplit"), wrap = wv.parentElement, on = !!(SPV.on && ed.doc);
  wrap.classList.toggle("spec", on);
  if (!on) { wv.style.height = ""; wv.classList.remove("gone"); return; }
  const H = wrap.clientHeight, top = Math.round(H * SPV.split);
  wv.style.height = top + "px";
  wv.classList.toggle("gone", top < 2);
  sp.style.top = top + "px";
  sp.style.height = Math.max(1, H - top) + "px";
  bar.style.top = Math.max(0, top - Math.floor((bar.offsetHeight || 9) / 2)) + "px";
  $("spTools").style.top = (top + 6) + "px";
}

function spDoc() {
  SPV.tiles.clear();
  SPV.want = new Set();
  SPV.gen++;
  SPV.layers = [null, null];
  SPV.lv = null;
  SPV.lkey = "";
  SPV.bkey = "";
  SPV.hover = null;
  SPV.err = "";
  SPV.sel = null;
  SPV.draft = null;
  SPV.sver++;
}

function spSame(A, B, a, b) {
  const x = sliceList(A, Math.max(0, a), b), y = sliceList(B, Math.max(0, a), b);
  return x.length === y.length && x.every((s, i) => sameSeg(s, y[i]));
}

function spAfterEdit() {
  SPV.want = new Set();
  if (!ed.clip) return;
  for (const [key, tl] of SPV.tiles) {
    const L = ed.clip.lists[tl.k];
    if (!L) { SPV.tiles.delete(key); continue; }
    if (tl.lists === L) continue;
    if (spSame(tl.lists, L, tl.a, tl.b)) tl.lists = L; else SPV.tiles.delete(key);
  }
  SPV.tver++;
}

function spEvict() {
  if (SPV.tiles.size <= SP_MAX) return;
  const arr = [...SPV.tiles.entries()].sort((p, q) => p[1].use - q[1].use);
  for (let i = 0; i < arr.length - SP_MAX; i++) SPV.tiles.delete(arr[i][0]);
}

function spTile(m) {
  if (!ed.doc || m.id !== ed.doc.id || m.ver !== ed.ver || !ed.clip) return;
  const key = m.key + "|" + m.T + "|" + m.k;
  SPV.want.delete(key);
  const parts = m.key.split("|"), n = Number(parts[1]), spp = Number(parts[5]);
  const rows = m.data.length / SP_TILE;
  if (!rows || rows !== Math.floor(rows)) return;
  const cv = document.createElement("canvas");
  cv.width = SP_TILE;
  cv.height = rows;
  const g = cv.getContext("2d"), img = g.createImageData(SP_TILE, rows), px = new Uint32Array(img.data.buffer), d = m.data;
  for (let c = 0; c < SP_TILE; c++) {
    const o = c * rows;
    for (let r = 0; r < rows; r++) px[r * SP_TILE + c] = SP_LUT[d[o + r]];
  }
  g.putImageData(img, 0, 0);
  const tl = { cv, vals: d, rows, k: m.k, T: m.T, lists: ed.clip.lists[m.k], a: Math.floor(m.T * SP_TILE * spp - n / 2) - 2, b: Math.ceil((m.T + 1) * SP_TILE * spp + n / 2) + 2, use: SPV.use };
  SPV.tiles.set(key, tl);
  spEvict();
  const lv = SPV.lv, L = SPV.layers[0];
  if (lv && L && lv.pkey === m.key) { spPut(L.getContext("2d"), tl, lv); SPV.bkey = ""; }
  else SPV.tver++;
  redraw();
}

function spPut(g, tl, lv) {
  const x = (tl.T * SP_TILE - lv.gA) * lv.dpr, w = SP_TILE * lv.dpr;
  if (x + w < 0 || x > lv.W) return;
  g.drawImage(tl.cv, 0, 0, SP_TILE, tl.rows, x, tl.k * lv.laneH, w, lv.laneH);
  const xe = (ed.doc.frames - lv.start) / lv.spp * lv.dpr;
  if (xe < lv.W) { g.fillStyle = SP_BG; g.fillRect(Math.max(0, Math.floor(xe)), 0, lv.W, lv.H); }
}

function spErr(m) {
  if (m.gen !== SPV.gen) return;
  SPV.err = m.msg || "error";
  SPV.bkey = "";
  redraw();
}

function spRequest(pkey, n, rows, sppD, list) {
  if (!list.length) return;
  const keys = list.map(([T, k]) => pkey + "|" + T + "|" + k);
  if (keys.every(k => SPV.want.has(k))) return;
  SPV.gen++;
  SPV.want = new Set(keys);
  ed.worker.postMessage({ t: "spec", id: ed.doc.id, ver: ed.ver, gen: SPV.gen, key: pkey, n, rows, log: SPV.log, top: 0, range: SPV.range, spp: sppD, tiles: list });
}

function spGeom() {
  const cv = $("sp"), dpr = canvasFit(cv), W = cv.width, H = cv.height;
  const ch = ed.doc.channels, laneH = Math.max(1, Math.floor(H / ch)), rows = Math.max(16, laneH);
  const n = spN(), spp = ed.view.spp, start = ed.view.start;
  return { cv, dpr, W, H, ch, laneH, rows, n, spp, start, gA: start / spp, sr: ed.doc.sampleRate, pkey: [ed.doc.id, n, rows, SPV.log ? 1 : 0, SPV.range, spp].join("|") };
}

function drawSpec() {
  if (!SPV.on || !ed.doc) return;
  const G = spGeom(), { cv, dpr, W, H, ch, laneH, rows, n, spp, start, gA, pkey } = G;
  const g = cv.getContext("2d");
  const T0 = Math.floor(gA / SP_TILE), T1 = Math.floor((gA + W / dpr) / SP_TILE), lastT = Math.floor(ed.doc.frames / spp / SP_TILE);
  SPV.use++;
  const vis = [];
  for (let k = 0; k < ch; k++) for (let T = Math.max(0, T0); T <= Math.min(T1, lastT); T++) vis.push([T, k]);
  let have = 0;
  for (const [T, k] of vis) { const tl = SPV.tiles.get(pkey + "|" + T + "|" + k); if (tl) { tl.use = SPV.use; have++; } }
  const lkey = [pkey, W, H, start, SPV.tver].join("|");
  if (lkey !== SPV.lkey) {
    const prev = SPV.layers[0], next = SPV.layers[1] || document.createElement("canvas");
    next.width = W;
    next.height = H;
    const lg = next.getContext("2d");
    lg.fillStyle = SP_BG;
    lg.fillRect(0, 0, W, H);
    const old = SPV.lv, lv = { pkey, start, spp, gA, dpr, W, H, laneH, log: SPV.log, ch, id: ed.doc.id };
    if (have < vis.length && prev && old && old.log === SPV.log && old.ch === ch && old.id === ed.doc.id) {
      const sc = old.spp / spp * dpr / old.dpr;
      lg.drawImage(prev, 0, 0, old.W, old.H, (old.start - start) / spp * dpr, 0, old.W * sc, H);
    }
    for (const [T, k] of vis) {
      const tl = SPV.tiles.get(pkey + "|" + T + "|" + k);
      if (tl) spPut(lg, tl, lv);
    }
    const xe = (ed.doc.frames - start) / spp * dpr;
    if (xe < W) { lg.fillStyle = SP_BG; lg.fillRect(Math.max(0, Math.floor(xe)), 0, W, H); }
    SPV.layers = [next, prev];
    SPV.lv = lv;
    SPV.lkey = lkey;
  }
  if (have < vis.length) {
    const c = (T0 + T1) / 2, miss = vis.filter(([T, k]) => !SPV.tiles.has(pkey + "|" + T + "|" + k));
    for (let k = 0; k < ch; k++) for (const T of [T0 - 1, T1 + 1]) if (T >= 0 && T <= lastT && !SPV.tiles.has(pkey + "|" + T + "|" + k)) miss.push([T, k]);
    miss.sort((p, q) => Math.abs(p[0] - c) - Math.abs(q[0] - c) || p[1] - q[1]);
    spRequest(pkey, n, rows, spp, miss);
  }
  const marks = shownMarks().map(m => m.a + ":" + (m.kind === "range" ? m.b : "")).join(",");
  if (SPV.sel && (SPV.sel.a !== ed.sel.a || SPV.sel.b !== ed.sel.b)) { SPV.sel = null; SPV.sver++; }
  const bkey = [SPV.lkey, ed.sel.a, ed.sel.b, ed.cursor, ed.chans.join(), marks, SPV.err, SPV.sver, SPV.log].join("|");
  if (bkey !== SPV.bkey) {
    const B = SPV.buf || (SPV.buf = document.createElement("canvas"));
    B.width = W;
    B.height = H;
    const bg = B.getContext("2d");
    bg.drawImage(SPV.layers[0], 0, 0);
    spOverlay(bg, G);
    SPV.bkey = bkey;
  }
  g.drawImage(SPV.buf, 0, 0);
  if (ed.play.on) {
    const px = Math.round(xOf(playhead()) * dpr);
    if (px >= 0 && px <= W) { g.fillStyle = "#f2efe9"; g.fillRect(px, 0, Math.max(1, dpr), H); }
  }
  if (SPV.draft) spDrawShape(g, G, SPV.draft, true);
  if (SPV.hover) {
    if (SPV.tool === "brush" && !SPV.draft) spBrushRing(g, G);
    spReadout(g, G);
  }
}

function spOverlay(g, G) {
  const { W, H, ch, laneH, dpr, n, sr } = G;
  if (selOn() && !spSelLive()) {
    const sx0 = Math.max(0, Math.floor(xOf(ed.sel.a) * dpr)), sx1 = Math.min(W, Math.ceil(xOf(ed.sel.b) * dpr));
    for (let k = 0; k < ch; k++) {
      if (!ed.chans[k]) continue;
      g.fillStyle = "rgba(255,255,255,0.11)";
      g.fillRect(sx0, k * laneH, Math.max(1, sx1 - sx0), laneH);
      g.fillStyle = "rgba(255,255,255,0.45)";
      g.fillRect(sx0, k * laneH, Math.max(1, dpr), laneH);
      g.fillRect(Math.max(0, sx1 - Math.max(1, dpr)), k * laneH, Math.max(1, dpr), laneH);
    }
  }
  g.fillStyle = "rgba(255,255,255,0.14)";
  for (let k = 1; k < ch; k++) g.fillRect(0, k * laneH, W, Math.max(1, dpr));
  g.fillStyle = "rgba(90,193,249,0.6)";
  for (const m of shownMarks()) {
    for (const f of m.kind === "range" ? [m.a, m.b] : [m.a]) {
      const x = Math.round(xOf(f) * dpr);
      if (x < 0 || x > W) continue;
      for (let y = 0; y < H; y += 7 * dpr) g.fillRect(x, y, Math.max(1, dpr), 4 * dpr);
    }
  }
  if (spSelLive()) for (const s of SPV.sel.shapes) spDrawShape(g, G, s, false);
  spLabels(g, W, laneH, ch, dpr, n, sr);
  const cx = Math.round(xOf(ed.cursor) * dpr);
  if (cx >= 0 && cx <= W) { g.fillStyle = "#DF9A24"; g.fillRect(cx, 0, Math.max(1, dpr), H); }
  if (SPV.err) {
    g.font = (11 * dpr) + "px JetBrains Mono, monospace";
    g.textAlign = "left";
    g.textBaseline = "top";
    g.fillStyle = "#e0a090";
    g.fillText(t("Spectrogram") + ": " + SPV.err, 8 * dpr, 8 * dpr);
  }
}

function spLabels(g, W, laneH, ch, dpr, n, sr) {
  const nyq = sr / 2;
  let fs;
  if (SPV.log) fs = [20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000];
  else {
    const px = laneH / dpr, step = [500, 1000, 2000, 5000, 10000, 20000, 50000].find(s => px * s / nyq >= 26) || 50000;
    fs = [];
    for (let f = step; f < nyq; f += step) fs.push(f);
  }
  g.font = (9 * dpr) + "px JetBrains Mono, monospace";
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (let k = 0; k < ch; k++) {
    const top = k * laneH;
    let lastY = Infinity;
    for (const f of fs) {
      if (f >= nyq * 0.99 || f < spLo(n, sr)) continue;
      const u = spU(f, n, sr);
      if (!(u > 0 && u < 1)) continue;
      const y = top + (1 - u) * laneH;
      if (y < top + 6 * dpr || y > top + laneH - 5 * dpr || Math.abs(y - lastY) < 13 * dpr) continue;
      lastY = y;
      g.fillStyle = "rgba(255,255,255,0.22)";
      g.fillRect(W - 40 * dpr, Math.round(y), 4 * dpr, Math.max(1, dpr));
      g.fillStyle = "rgba(10,9,8,0.72)";
      g.fillRect(W - 34 * dpr, y - 5 * dpr, 34 * dpr, 10 * dpr);
      g.fillStyle = "#a39d93";
      g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), W - 4 * dpr, y);
    }
    if (ch > 1) {
      g.textAlign = "left";
      g.fillStyle = "rgba(10,9,8,0.6)";
      g.fillRect(3 * dpr, top + 3 * dpr, 14 * dpr, 12 * dpr);
      g.fillStyle = ed.chans[k] ? "#c9c3b9" : "#5f5a52";
      g.fillText(chanName(k, ch), 6 * dpr, top + 9 * dpr);
      g.textAlign = "right";
    }
  }
}

function spAt(G, cssX, cssY) {
  const { dpr, laneH, ch, n, sr, gA, pkey } = G;
  const yd = cssY * dpr, k = Math.min(ch - 1, Math.max(0, Math.floor(yd / laneH))), yl = yd - k * laneH;
  const u = Math.max(0, Math.min(1, 1 - (yl + 0.5) / laneH));
  const f = spF(u, n, sr);
  const gc = Math.floor(gA + cssX), T = Math.floor(gc / SP_TILE), col = gc - T * SP_TILE;
  const tl = SPV.tiles.get(pkey + "|" + T + "|" + k);
  let db = null;
  if (tl && col >= 0 && col < SP_TILE) {
    const r = Math.max(0, Math.min(tl.rows - 1, Math.floor(yl / laneH * tl.rows)));
    db = -SPV.range + tl.vals[col * tl.rows + r] / 255 * SPV.range;
  }
  return { k, f, db, frame: frameAt(cssX) };
}

function spReadout(g, G) {
  const h = SPV.hover, { dpr, W, H } = G;
  if (!h || h.x < 0 || h.y < 0 || h.x * dpr > W || h.y * dpr > H) return;
  const a = spAt(G, h.x, h.y);
  const txt = spHz(a.f) + (a.db !== null ? " · " + (a.db <= -SPV.range + 0.5 ? "≤ " : "") + Math.round(a.db) + " dB" : "");
  g.font = (10 * dpr) + "px JetBrains Mono, monospace";
  g.textAlign = "left";
  g.textBaseline = "middle";
  const w = g.measureText(txt).width + 10 * dpr, bh = 16 * dpr;
  let x = h.x * dpr + 12 * dpr, y = h.y * dpr - 20 * dpr;
  if (x + w > W - 44 * dpr) x = h.x * dpr - 12 * dpr - w;
  if (y < 2 * dpr) y = h.y * dpr + 12 * dpr;
  g.fillStyle = "rgba(12,10,9,0.86)";
  g.fillRect(x, y, w, bh);
  g.fillStyle = "#f2efe9";
  g.fillText(txt, x + 5 * dpr, y + bh / 2);
}

function spSelLive() {
  return !!(SPV.sel && SPV.on && ed.doc && SPV.sel.shapes.length && SPV.sel.a === ed.sel.a && SPV.sel.b === ed.sel.b);
}

function spY(G, f, k) {
  const u = Math.max(0, Math.min(1, f <= 0 ? 0 : spU(f, G.n, G.sr)));
  return k * G.laneH + (1 - u) * G.laneH;
}

function spPoint(G, cssX, cssY, k) {
  const yl = cssY * G.dpr - k * G.laneH;
  const u = Math.max(0, Math.min(1, 1 - yl / G.laneH));
  const f = u <= 0.001 ? 0 : u >= 0.999 ? G.sr / 2 : spF(u, G.n, G.sr);
  return [Math.max(0, Math.min(ed.doc.frames, frameAt(cssX))), f];
}

function spDrawShape(g, G, s, live) {
  const { dpr } = G;
  for (let k = 0; k < G.ch; k++) {
    if (!s.ch[k]) continue;
    g.save();
    g.beginPath();
    g.rect(0, k * G.laneH, G.W, G.laneH);
    g.clip();
    if (s.kind === "brush") {
      g.strokeStyle = "rgba(223,57,187,0.42)";
      g.lineWidth = SPV.brush * dpr;
      g.lineCap = "round";
      g.lineJoin = "round";
      g.beginPath();
      s.pts.forEach(([t0, f], i) => { const x = xOf(t0) * dpr, y = spY(G, f, k); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      if (s.pts.length === 1) g.lineTo(xOf(s.pts[0][0]) * dpr + 0.01, spY(G, s.pts[0][1], k));
      g.stroke();
      g.restore();
      continue;
    }
    g.beginPath();
    if (s.kind === "rect") {
      const x0 = xOf(s.a) * dpr, x1 = xOf(s.b) * dpr, y0 = spY(G, s.f1, k), y1 = spY(G, s.f0, k);
      g.rect(x0, y0, Math.max(dpr, x1 - x0), Math.max(dpr, y1 - y0));
    } else {
      s.pts.forEach(([t0, f], i) => { const x = xOf(t0) * dpr, y = spY(G, f, k); if (i) g.lineTo(x, y); else g.moveTo(x, y); });
      if (!live) g.closePath();
    }
    g.fillStyle = "rgba(90,193,249,0.16)";
    g.fill();
    g.setLineDash([4 * dpr, 3 * dpr]);
    g.lineWidth = Math.max(1, dpr);
    g.strokeStyle = "rgba(140,214,255,0.95)";
    g.stroke();
    g.restore();
  }
}

function spBrushRing(g, G) {
  const h = SPV.hover, r = SPV.brush / 2 * G.dpr;
  g.save();
  g.beginPath();
  g.arc(h.x * G.dpr, h.y * G.dpr, r, 0, Math.PI * 2);
  g.lineWidth = Math.max(1, G.dpr);
  g.strokeStyle = "rgba(242,239,233,0.85)";
  g.stroke();
  g.restore();
}

function spSpan(shapes) {
  let a = Infinity, b = -Infinity;
  for (const s of shapes) {
    if (s.kind === "rect") { a = Math.min(a, s.a); b = Math.max(b, s.b); continue; }
    for (const p of s.pts) { a = Math.min(a, p[0]); b = Math.max(b, p[0]); }
  }
  return [Math.max(0, Math.floor(a)), Math.min(ed.doc.frames, Math.ceil(b))];
}

function spCommit(s, add) {
  const shapes = (add && spSelLive() ? SPV.sel.shapes : []).concat([s]);
  const [a, b] = spSpan(shapes);
  if (b <= a) return;
  ed.sel = { a, b };
  ed.cursor = a;
  SPV.sel = { shapes, a, b };
  SPV.sver++;
}

function spEdit(op, shapes, src) {
  if (!ed.doc || !shapes || !shapes.length) return;
  const clean = shapes.map(s => s.kind === "rect" ? { kind: "rect", a: s.a, b: s.b, f0: s.f0, f1: s.f1, ch: s.ch } : s.kind === "poly" ? { kind: "poly", pts: s.pts, ch: s.ch } : { kind: "brush", pts: s.pts, rx: s.rx, ru: s.ru, ch: s.ch });
  return runEdit({ t: "edit", op, shapes: clean, un: spN(), log: SPV.log, src }, false, true);
}

function spSetTool(tool, toggle) {
  if (toggle && SPV.tool === tool) tool = "time";
  SPV.tool = tool;
  spSave("studioSpecTool", tool);
  if (tool !== "time" && !SPV.on && ed.doc) spToggle();
  SPV.draft = null;
  spToolsUi();
  redraw();
}

function spToolsUi() {
  const box = $("spTools");
  if (!box) return;
  box.querySelectorAll("button[data-tool]").forEach(b => b.classList.toggle("on", b.dataset.tool === SPV.tool));
  box.classList.toggle("brush", SPV.tool === "brush");
  $("spBrush").value = SPV.brush;
  $("spBrushV").textContent = SPV.brush + " px";
  const sp = $("sp");
  sp.style.cursor = SPV.tool === "brush" ? "none" : SPV.tool === "time" ? "text" : "crosshair";
}

function spDown(e) {
  const sp = $("sp");
  if (!ed.doc || SPV.tool === "time" || e.button > 0 || (IS_MAC && e.ctrlKey)) return;
  e.preventDefault();
  sp.setPointerCapture(e.pointerId);
  const r = sp.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  const G = spGeom(), k = Math.min(G.ch - 1, Math.max(0, Math.floor(y * G.dpr / G.laneH)));
  const ch = ed.chans.every(Boolean) ? ed.chans.map(() => true) : ed.chans.map((_, i) => i === k);
  const p = spPoint(G, x, y, k);
  const base = { ch, lane: k, x0: x, y0: y, moved: false, add: e.shiftKey };
  if (SPV.tool === "rect") SPV.draft = Object.assign(base, { kind: "rect", p0: p, a: p[0], b: p[0], f0: p[1], f1: p[1] });
  else if (SPV.tool === "lasso") SPV.draft = Object.assign(base, { kind: "poly", pts: [p] });
  else SPV.draft = Object.assign(base, { kind: "brush", pts: [p], rx: SPV.brush / 2 * ed.view.spp, ru: SPV.brush / 2 / (G.laneH / G.dpr) });
  redraw();
}

function spMove(e) {
  const d = SPV.draft;
  if (!d) return;
  const sp = $("sp"), r = sp.getBoundingClientRect(), x = Math.max(0, Math.min(r.width, e.clientX - r.left)), y = e.clientY - r.top;
  if (!d.moved && Math.hypot(x - d.x0, y - d.y0) < 3) return;
  d.moved = true;
  const G = spGeom(), p = spPoint(G, x, y, d.lane);
  if (d.kind === "rect") { d.a = Math.min(d.p0[0], p[0]); d.b = Math.max(d.p0[0], p[0]); d.f0 = Math.min(d.p0[1], p[1]); d.f1 = Math.max(d.p0[1], p[1]); }
  else {
    const last = d.pts[d.pts.length - 1], lx = xOf(last[0]), ly = spY(G, last[1], d.lane) / G.dpr;
    if (Math.hypot(x - lx, y - ly) >= 2) d.pts.push(p);
  }
  redraw();
}

function spUp() {
  const d = SPV.draft;
  if (!d) return;
  SPV.draft = null;
  if (!d.moved && d.kind !== "brush") {
    ed.sel = { a: 0, b: 0 };
    ed.cursor = Math.round(d.kind === "rect" ? d.p0[0] : d.pts[0][0]);
    if (ed.play.on) startPlay(ed.cursor);
    redraw();
    return;
  }
  if (d.kind === "brush") { spEdit("spheal", [{ kind: "brush", pts: d.pts, rx: d.rx, ru: d.ru, ch: d.ch }], "brush"); redraw(); return; }
  if (d.kind === "rect") spCommit({ kind: "rect", a: Math.round(d.a), b: Math.round(d.b), f0: d.f0, f1: d.f1, ch: d.ch }, d.add);
  else if (d.pts.length >= 3) spCommit({ kind: "poly", pts: d.pts, ch: d.ch }, d.add);
  redraw();
}

function spToggle() {
  SPV.on = !SPV.on;
  spSave("studioSpec", SPV.on ? "1" : "0");
  SPV.lkey = "";
  SPV.bkey = "";
  SPV.hover = null;
  redraw();
}

function spSetScale(log) {
  if (SPV.log === log) return;
  SPV.log = log;
  spSave("studioSpecScale", log ? "log" : "lin");
  SPV.want = new Set();
  SPV.lv = null;
  SPV.lkey = "";
  spSettingsUi();
  redraw();
}

function spScaleToggle() { spSetScale(!SPV.log); }

function spSettingsUi() {
  document.querySelectorAll("#spScaleSeg button").forEach(b => b.classList.toggle("on", (b.dataset.v === "log") === SPV.log));
}

function wireSpec() {
  const sp = $("sp"), bar = $("spSplit");
  sp.addEventListener("pointermove", e => {
    if (!ed.doc) return;
    const r = sp.getBoundingClientRect();
    SPV.hover = e.pointerType === "touch" ? null : { x: e.clientX - r.left, y: e.clientY - r.top };
    redraw();
  });
  sp.addEventListener("pointerleave", () => { if (SPV.hover) { SPV.hover = null; redraw(); } });
  let drag = null;
  bar.addEventListener("pointerdown", e => {
    if (e.button > 0 || !ed.doc) return;
    e.preventDefault();
    bar.setPointerCapture(e.pointerId);
    drag = { y0: e.clientY, s0: SPV.split };
  });
  bar.addEventListener("pointermove", e => {
    if (!drag) return;
    const H = bar.parentElement.clientHeight || 1;
    let s = drag.s0 + (e.clientY - drag.y0) / H;
    s = Math.max(0, Math.min(0.88, s));
    if (s < 0.04) s = 0;
    SPV.split = s;
    redraw();
  });
  const end = () => { if (!drag) return; drag = null; spSave("studioSpecSplit", SPV.split); };
  bar.addEventListener("pointerup", end);
  bar.addEventListener("pointercancel", end);
  bar.addEventListener("dblclick", () => { SPV.split = SPV.split > 0.04 ? 0 : 0.42; spSave("studioSpecSplit", SPV.split); redraw(); });
  sp.addEventListener("pointerdown", spDown);
  sp.addEventListener("pointermove", spMove);
  sp.addEventListener("pointerup", spUp);
  sp.addEventListener("pointercancel", () => { if (SPV.draft) { SPV.draft = null; redraw(); } });
  $("spTools").addEventListener("click", e => { const b = e.target.closest("button[data-tool]"); if (!b) return; e.stopPropagation(); b.blur(); spSetTool(b.dataset.tool); });
  $("spBrush").addEventListener("input", e => { SPV.brush = Math.max(4, Math.min(120, Number(e.target.value) || 24)); spSave("studioSpecBrush", SPV.brush); spToolsUi(); redraw(); });
  spToolsUi();
  $("specSeg").addEventListener("click", e => { if (e.target.closest("button")) { e.currentTarget.querySelector("button").blur(); spToggle(); } });
  $("spScaleSeg").addEventListener("click", e => { const b = e.target.closest("button"); if (b) spSetScale(b.dataset.v === "log"); });
  ddInit($("spResDd"), [{ v: "auto", label: "Auto" }, ...[512, 1024, 2048, 4096, 8192, 16384].map(v => ({ v: String(v), label: String(v) }))], SPV.res, v => { SPV.res = v; spSave("studioSpecRes", v); SPV.want = new Set(); redraw(); });
  ddInit($("spRangeDd"), [80, 100, 120, 140, 160].map(v => ({ v: String(v), label: v + " dB" })), String(SPV.range), v => { SPV.range = Number(v); spSave("studioSpecRange", v); SPV.want = new Set(); redraw(); });
  spSettingsUi();
}

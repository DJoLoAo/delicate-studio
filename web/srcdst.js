const sd = { open: false, doc: null, len: 0, a: 0, b: 0, cur: 0, drag: null, prev: null, raf: 0 };

function sdKey() { return "studioSrc:" + (ses.s ? ses.s.id : ""); }

function sdSave() {
  try { localStorage.setItem(sdKey(), JSON.stringify({ open: sd.open, doc: sd.doc, a: sd.a, b: sd.b, cur: sd.cur })); } catch {}
}

function sdM() { const M = sd.doc && ses.docs.get(sd.doc); return M && !M.missing ? M : null; }

function sdIo() {
  const sr = ssRate(), M = sdM();
  if (!M) return t("Choose a source file");
  return t("In") + " " + fmtTime(sd.a) + " · " + t("Out") + " " + fmtTime(sd.b) + " · " + fmtDur((sd.b - sd.a) / sr);
}

async function sdRestore() {
  sdPrevStop();
  sd.open = false; sd.doc = null; sd.len = 0; sd.a = sd.b = sd.cur = 0;
  let v = null;
  try { v = JSON.parse(localStorage.getItem(sdKey()) || "null"); } catch {}
  if (v && v.doc && !ses.docs.has(v.doc)) { try { const p = (await call({ t: "sesdoc", id: v.doc })).doc; if (p && !p.missing && ses.open) ssUse(p); } catch {} }
  if (!ses.open) return;
  if (v && v.doc && ses.docs.has(v.doc) && !ses.docs.get(v.doc).missing) {
    const M = ses.docs.get(v.doc);
    sd.doc = v.doc; sd.len = M.len;
    sd.a = Math.max(0, Math.min(M.len, v.a | 0)); sd.b = Math.max(sd.a, Math.min(M.len, v.b | 0)); sd.cur = Math.max(0, Math.min(M.len, v.cur | 0));
  }
  sd.open = !!(v && v.open);
  sdShow();
}

function sdShow() {
  const el = $("srcp");
  if (!el) return;
  el.classList.toggle("hidden", !sd.open || !ses.open || ses.mode === "scenes");
  const b = $("sesSrcBtn");
  if (b) b.classList.toggle("on", sd.open);
  if (sd.open) { sdDocDd(); sdDraw(); }
}

function sdToggle() {
  if (!ses.open) return;
  if (ses.mode === "scenes") snMode("multi");
  sd.open = !sd.open;
  if (!sd.open) sdPrevStop();
  sdSave();
  sdShow();
}

async function sdDocDd() {
  const el = $("srcDoc");
  let docs = [];
  try { docs = (await call({ t: "list" })).docs.filter(d => !d.recording); } catch {}
  const items = docs.slice(0, 300).map(d => ({ v: d.id, label: d.name }));
  fxDd(el, items.length ? items : [{ v: "", label: t("There are no files in Studio yet.") }], v => { if (v) sdPick(v); });
  const M = sdM();
  el.querySelector(".cur").textContent = M ? (M.meta.name || "") : t("Choose a source file");
  $("srcIo").textContent = sdIo();
}

async function sdPick(id) {
  const p = await ssPrepDoc(id);
  if (!p || !ses.open) return;
  sdPrevStop();
  sd.doc = p.id;
  sd.len = p.len;
  sd.a = 0;
  sd.b = p.len;
  sd.cur = 0;
  sdSave();
  $("srcDoc").querySelector(".cur").textContent = p.meta.name || "";
  sdDocDd();
  sdDraw();
}

function sdX(f, W) { return sd.len ? f / sd.len * W : 0; }
function sdF(x, W) { return Math.max(0, Math.min(sd.len, Math.round(x / Math.max(1, W) * sd.len))); }

function sdDraw() {
  if (!sd.open) return;
  const cv = $("srcCv"), dpr = canvasFit(cv), g = cv.getContext("2d"), W = cv.width, H = cv.height, M = sdM();
  g.fillStyle = TH.canvas;
  g.fillRect(0, 0, W, H);
  $("srcIo").textContent = sdIo();
  if (!M) {
    g.fillStyle = TH.muted;
    g.font = thFont(11, dpr);
    g.textBaseline = "middle";
    g.fillText(t("Pick the file to take material from: a rip, a take, a recording."), 12 * dpr, H / 2);
    return;
  }
  const a = sdX(sd.a, W), b = sdX(sd.b, W);
  g.fillStyle = tc("gold", 0.16);
  g.fillRect(a, 0, Math.max(1, b - a), H);
  const mid = H / 2, A = H / 2 - 3 * dpr, ch = M.meta.channels, acc = accNew();
  g.fillStyle = tc("blue", 0.85);
  for (let x = 0; x < W; x++) {
    const u0 = Math.floor(x / W * sd.len), u1 = Math.max(u0 + 1, Math.floor((x + 1) / W * sd.len));
    accReset(acc);
    for (let c = 0; c < ch; c++) colPeakOf(M, c, u0, u1, acc);
    if (acc.mx === -Infinity) continue;
    const y1 = mid - Math.max(-1, Math.min(1, acc.mx)) * A, y2 = mid - Math.max(-1, Math.min(1, acc.mn)) * A;
    g.fillRect(x, y1, 1, Math.max(1, y2 - y1));
  }
  g.fillStyle = TH.gold;
  g.fillRect(Math.round(a), 0, Math.max(1, dpr) * 2, H);
  g.fillRect(Math.round(b) - dpr, 0, Math.max(1, dpr) * 2, H);
  const p = sd.prev ? sdPrevPos() : sd.cur, px = Math.round(sdX(p, W));
  g.fillStyle = sd.prev ? TH.ink : TH.pink;
  g.fillRect(px, 0, Math.max(1, dpr), H);
}

function sdPrevPos() { const P = sd.prev; return P ? Math.min(sd.len, P.from + Math.max(0, (P.ctx.currentTime - P.t0)) * P.sr) : sd.cur; }

function sdPrevStop() {
  const P = sd.prev;
  sd.prev = null;
  cancelAnimationFrame(sd.raf);
  if (P) { try { P.src.stop(); } catch {} try { P.ctx.close(); } catch {} }
  const b = $("srcPlay");
  if (b) b.classList.remove("on");
}

async function sdPreview() {
  if (sd.prev) { const P = sd.prev; sd.cur = Math.round(Math.min(sd.len, P.from + (P.ctx.currentTime - P.t0) * P.sr)); sdPrevStop(); sdSave(); sdDraw(); return; }
  const M = sdM();
  if (!M) return;
  if (ses.play.on) ssStop();
  const from = sd.cur >= sd.len - 1 ? sd.a : sd.cur;
  let r;
  try { r = await call({ t: "scread", doc: sd.doc, from, len: sd.len - from }); } catch (e) { tell(String(e.message || e)); return; }
  if (!r.n) return;
  const ctx = new AudioContext({ sampleRate: r.sr, latencyHint: "interactive" }), buf = ctx.createBuffer(r.ch, r.n, r.sr);
  for (let c = 0; c < r.ch; c++) buf.copyToChannel(r.data.subarray(c * r.n, (c + 1) * r.n), c);
  const src = ctx.createBufferSource();
  src.buffer = buf;
  src.connect(ctx.destination);
  src.onended = () => { if (sd.prev && sd.prev.src === src) { sdPrevStop(); sdDraw(); } };
  const t0 = ctx.currentTime + 0.02;
  src.start(t0);
  sd.prev = { ctx, src, from, sr: r.sr, t0 };
  $("srcPlay").classList.add("on");
  const tick = () => { if (!sd.prev) return; sdDraw(); sd.raf = requestAnimationFrame(tick); };
  sd.raf = requestAnimationFrame(tick);
}

function sdMark(which) {
  if (!sdM()) return;
  const p = Math.round(sd.prev ? sdPrevPos() : sd.cur);
  if (which === "in") { sd.a = p; if (sd.b <= sd.a) sd.b = sd.len; }
  else { sd.b = p; if (sd.a >= sd.b) sd.a = 0; }
  sdSave();
  sdDraw();
  flash((which === "in" ? t("Source in") : t("Source out")) + " " + fmtTime(p));
}

function sdTarget() {
  return ses.s.tracks.find(tr => tr.id === ses.track) || ses.s.tracks[0] || pcNewTrack();
}

function sdDest() { return Math.round(ses.sel.b > ses.sel.a ? ses.sel.a : ses.cursor); }

function sdOverwrite() {
  const M = sdM(), n = sd.b - sd.a;
  if (!M || n < 2) { flash(t("Set In and Out in the source first.")); return; }
  const tr = sdTarget(), a = sdDest();
  if (!pcPlace(tr, { doc: sd.doc, at: a - sd.a, from: 0, len: sd.len, name: M.meta.name }, a, a + n, true)) return;
  ses.track = tr.id;
  ses.cursor = a + n;
  ses.sel = { a: 0, b: 0 };
  ssCommit();
  flash(t("Overwrote {d} on {n}").replace("{d}", fmtDur(n / ssRate())).replace("{n}", tr.name));
}

function sdShiftPts(pts, a, n) {
  if (!pts.length) return pts;
  const v = smAt(pts, a), out = pts.filter(q => q[0] < a).concat([[a, v], [a + n, v]]).concat(pts.filter(q => q[0] >= a).map(q => [q[0] + n, q[1]]));
  return out.sort((p, q) => p[0] - q[0]).filter((q, i, A) => i === 0 || q[0] !== A[i - 1][0]);
}

function sdRipple(a, n, X) {
  for (const tr of ses.s.tracks) {
    const out = [];
    for (const k of tr.clips) {
      const e = k.at + k.len;
      if (e <= a) { out.push(k); continue; }
      if (k.at >= a) { out.push(Object.assign({}, k, { at: k.at + n })); continue; }
      const ll = a - k.at, rl = e - a;
      out.push(Object.assign({}, k, { len: ll, fin: Math.min(k.fin, ll), fout: Math.min(X, ll) }));
      out.push(Object.assign({}, k, { id: ssNewId(), at: a + n, from: k.from + ll, len: rl, fin: Math.min(X, rl), fout: Math.min(k.fout, rl) }));
    }
    tr.clips = out.sort((p, q) => p.at - q.at);
    const au = ssAuto(tr);
    au.vol = sdShiftPts(au.vol, a, n);
    au.pan = sdShiftPts(au.pan, a, n);
    for (const q of tr.takes || []) if (q.at >= a) q.at += n;
  }
  for (const m of ses.s.marks || []) if (m.at >= a) m.at += n;
}

function sdInsert() {
  const M = sdM(), n = sd.b - sd.a;
  if (!M || n < 2) { flash(t("Set In and Out in the source first.")); return; }
  const tr = sdTarget(), a = sdDest(), sr = ssRate(), X = Math.max(2, Math.round(sr * PC_XF)), h = X >> 1;
  sdRipple(a, n, X);
  let pre = Math.min(h, sd.a), post = Math.min(h, sd.len - sd.b);
  const left = tr.clips.find(k => k.at + k.len === a), right = tr.clips.find(k => k.at === a + n);
  if (left && left.from + left.len + h <= ssDocLen(left) && pre === h) { left.len += h; left.fout = 0; } else pre = 0;
  if (right && right.from >= h && post === h) { right.at -= h; right.from -= h; right.len += h; right.fin = 0; } else post = 0;
  tr.clips.push({ id: ssNewId(), doc: sd.doc, at: a - pre, from: sd.a - pre, len: n + pre + post, gain: 0, fin: pre ? 0 : (left ? X : 0), fout: post ? 0 : (right ? X : 0), name: M.meta.name });
  tr.clips.sort((p, q) => p.at - q.at);
  ses.track = tr.id;
  ses.cursor = a + n;
  ses.sel = { a: 0, b: 0 };
  ssCommit();
  flash(t("Inserted {d} on {n}; what follows moved along on all tracks").replace("{d}", fmtDur(n / sr)).replace("{n}", tr.name));
}

function sdCut(a, b, X) {
  const n = b - a;
  for (const tr of ses.s.tracks) {
    const out = [];
    for (const k of tr.clips) {
      const e = k.at + k.len;
      if (e <= a) { out.push(k); continue; }
      if (k.at >= b) { out.push(Object.assign({}, k, { at: k.at - n })); continue; }
      if (k.at < a) { const ll = a - k.at; out.push(Object.assign({}, k, { len: ll, fin: Math.min(k.fin, ll), fout: Math.min(X, ll) })); }
      if (e > b) { const rl = e - b; out.push(Object.assign({}, k, { id: ssNewId(), at: a, from: k.from + (b - k.at), len: rl, fin: Math.min(X, rl), fout: Math.min(k.fout, rl) })); }
    }
    tr.clips = out.sort((p, q) => p.at - q.at);
    const au = ssAuto(tr);
    for (const kind of ["vol", "pan"]) {
      const pts = au[kind];
      if (!pts.length) continue;
      const v = smAt(pts, b);
      au[kind] = pts.filter(q => q[0] < a).concat([[a, v]]).concat(pts.filter(q => q[0] >= b).map(q => [q[0] - n, q[1]])).sort((p, q) => p[0] - q[0]).filter((q, i, A) => i === 0 || q[0] !== A[i - 1][0]);
    }
    for (const q of tr.takes || []) if (q.at >= b) q.at -= n;
  }
  for (const m of ses.s.marks || []) { if (m.at >= b) m.at -= n; else if (m.at > a) m.at = a; }
}

function sdReplace() {
  const M = sdM(), n = sd.b - sd.a;
  if (!M || n < 2) { flash(t("Set In and Out in the source first.")); return; }
  if (!(ses.sel.b > ses.sel.a)) { flash(t("Select the range to replace in the session first.")); return; }
  const tr = sdTarget(), a = Math.round(ses.sel.a), b = Math.round(ses.sel.b), d = b - a, sr = ssRate(), X = Math.max(2, Math.round(sr * PC_XF));
  if (n > d) sdRipple(b, n - d, X);
  else if (n < d) sdCut(a + n, b, X);
  if (!pcPlace(tr, { doc: sd.doc, at: a - sd.a, from: 0, len: sd.len, name: M.meta.name }, a, a + n, true)) return;
  ses.track = tr.id;
  ses.cursor = a + n;
  ses.sel = { a: 0, b: 0 };
  ssCommit();
  const diff = n - d, how = diff === 0 ? t("same length") : (diff > 0 ? t("{d} longer") : t("{d} shorter")).replace("{d}", fmtDur(Math.abs(diff) / sr));
  flash(t("Replaced {a} with {b} of the source on {n}; what follows moved along").replace("{a}", fmtDur(d / sr)).replace("{b}", fmtDur(n / sr)).replace("{n}", tr.name) + " · " + how);
}

function wireSrc() {
  const cv = $("srcCv");
  cv.addEventListener("pointerdown", e => {
    if (!sdM() || e.button > 0) return;
    const r = cv.getBoundingClientRect(), f = sdF(e.clientX - r.left, r.width);
    cv.setPointerCapture(e.pointerId);
    sd.drag = { f0: f, x0: e.clientX, moved: false };
  });
  cv.addEventListener("pointermove", e => {
    const d = sd.drag;
    if (!d) return;
    if (!d.moved && Math.abs(e.clientX - d.x0) < 3) return;
    d.moved = true;
    const r = cv.getBoundingClientRect(), f = sdF(e.clientX - r.left, r.width);
    sd.a = Math.min(d.f0, f);
    sd.b = Math.max(d.f0, f);
    sdDraw();
  });
  const up = () => {
    const d = sd.drag;
    sd.drag = null;
    if (!d) return;
    if (!d.moved) { sd.cur = d.f0; if (sd.prev) { sdPrevStop(); sdPreview(); } }
    sdSave();
    sdDraw();
  };
  cv.addEventListener("pointerup", up);
  cv.addEventListener("pointercancel", up);
  $("srcPlay").addEventListener("click", e => { e.currentTarget.blur(); sdPreview(); });
  $("srcIn").addEventListener("click", e => { e.currentTarget.blur(); sdMark("in"); });
  $("srcOut").addEventListener("click", e => { e.currentTarget.blur(); sdMark("out"); });
  $("srcOver").addEventListener("click", e => { e.currentTarget.blur(); sdOverwrite(); });
  $("srcIns").addEventListener("click", e => { e.currentTarget.blur(); sdInsert(); });
  $("srcRep").addEventListener("click", e => { e.currentTarget.blur(); sdReplace(); });
  $("srcX").addEventListener("click", () => sdToggle());
  window.addEventListener("resize", () => { if (sd.open) sdDraw(); });
}

const PX_NAMES = { fadein: "Fade in", fadeout: "Fade out", dc: "Remove DC offset", reverse: "Reverse", invert: "Invert", swap: "Swap channels", lr: "Copy left channel to right", rl: "Copy right channel to left", mono: "Mix to mono", msenc: "Mid/Side encode", msdec: "Mid/Side decode" };
const PX_CURVES = { lin: { shape: "lin", k: 0 }, log: { shape: "lin", k: 0.5 }, exp: { shape: "lin", k: -0.5 }, cos: { shape: "cos", k: 0 } };
const PX_BOX = 9, PX_TOP = 3, PX_DEAD = 6, PX_SPAN = 120;

const px = { seq: 0, job: null, fade: null, drag: null, hover: null };

function pxGain(f) {
  const z = px.fade;
  if (!z || !ed.doc) return 1;
  const F = ed.doc.frames, n1 = Math.max(1, z.len - 1);
  if (z.kind === "in") return f >= z.len ? 1 : fadeGain(Math.max(0, f) / n1, z.shape, z.k);
  const a = F - z.len;
  return f < a ? 1 : fadeGain(1 - Math.min(z.len - 1, f - a) / n1, z.shape, z.k);
}

function pxKey() {
  const z = px.fade;
  return z ? [z.kind, z.len, z.shape, z.k].join(",") : "";
}

function pxCurveName(shape, k) {
  const p = Math.round(Math.abs(k) * 100);
  if (shape === "cos") return t("S-curve") + (p ? " " + (k > 0 ? "+" : "−") + p + " %" : "");
  return p ? t(k > 0 ? "Logarithmic" : "Exponential") + " " + p + " %" : t("Linear");
}

function pxStatus() {
  const el = $("stMsg"), j = px.job;
  if (!j || !(j.frac > 0)) return;
  clearTimeout(ed.flashT);
  j.text = j.label + " · " + Math.round(j.frac * 100) + " % · " + t("Esc cancels");
  el.textContent = j.text;
}

function pxDone() {
  const j = px.job, el = $("stMsg");
  px.job = null;
  if (j && j.text && el.textContent === j.text) el.textContent = "";
}

function pxProg(m) {
  if (!px.job || m.id !== px.job.id) return;
  px.job.frac = m.frac;
  pxStatus();
}

function pxPct(v) {
  return (v < 0 ? "−" : "+") + Math.abs(v * 100).toLocaleString(undefined, { maximumSignificantDigits: 2 }) + " %";
}

async function pxRun(op, extra) {
  if (!ed.doc || ed.editing) return;
  const id = "p" + (++px.seq);
  px.job = { id, label: t(PX_NAMES[op] || op), frac: 0 };
  let r;
  try {
    r = await runEdit(Object.assign({ t: "proc", op, jobId: id }, extra || {}), false, true);
  } finally {
    pxDone();
    px.fade = null;
    redraw();
  }
  if (!r) return;
  if (op === "dc" && r.dc) {
    const names = r.dc.map((v, k) => v === null ? "" : (ed.doc.channels === 2 ? (k ? "R" : "L") : String(k + 1)) + " " + pxPct(v)).filter(Boolean);
    flash(t("DC offset removed") + ": " + names.join(", "));
  } else flash(t(PX_NAMES[op]) + " · " + fmtTime(ed.hist[ed.histIdx].a) + "–" + fmtTime(ed.hist[ed.histIdx].b));
  return r;
}

function pxErr(m) {
  if (m === "dc-none") { flash(t("There is no DC offset to remove.")); return true; }
  if (m === "px-stereo") { tell(t("This works on stereo files.")); return true; }
  return false;
}

function pxCurveGet() {
  let v = "lin";
  try { v = localStorage.getItem("studioFadeCurve") || "lin"; } catch {}
  return PX_CURVES[v] ? v : "lin";
}

async function pxFadeDlg(kind) {
  if (!ed.doc || !selOn()) return;
  const title = t(kind === "in" ? "Fade in" : "Fade out"), pick = pxCurveGet();
  const html = `<div class="dfield"><span>${esc(t("Curve"))}</span>${segHtml("curve", [["lin", "Linear"], ["log", "Logarithmic"], ["exp", "Exponential"], ["cos", "S-curve"]], pick)}</div>`
    + `<div class="dnote">${esc(t("Over the selection") + ", " + fmtTime(ed.sel.b - ed.sel.a) + ". " + t("The fade handles at the top corners of the waveform fade the start or end of the file."))}</div>`;
  const v = await askForm(title, html, { ok: t("apply"), setup: segSetup, read: () => segRead(document.querySelector("#dlg .dform")) });
  if (!v) return;
  const key = PX_CURVES[v.curve] ? v.curve : "lin";
  try { localStorage.setItem("studioFadeCurve", key); } catch {}
  return pxRun(kind === "in" ? "fadein" : "fadeout", { cfg: PX_CURVES[key] });
}

async function pxNewFile(mode) {
  if (!ed.doc || ed.editing) return;
  const id = "p" + (++px.seq), src = ed.doc.name;
  const stem = src.replace(/\.[^.]+$/, "") || src;
  const tag = { mix: t("mono"), left: t("left"), right: t("right"), stereo: t("stereo") }[mode];
  px.job = { id, label: t("New file"), frac: 0 };
  ed.editing = true;
  let r = null;
  try {
    r = await call({ t: "pxnew", id: ed.doc.id, mode, jobId: id, name: stem + " (" + tag + ")" });
  } catch (e) {
    const m = e && e.message || String(e);
    if (m !== "cancelled" && m !== "stale" && !pxErr(m)) tell(m === "quota" ? t("Browser storage is full. Remove files from Studio's list to make room.") : m, t("Could not make the file"));
  } finally {
    ed.editing = false;
    pxDone();
  }
  if (!r) return;
  await openDoc(r.meta.id);
  refreshFiles();
  flash(t("New file made from") + " " + src + ". " + t("The original is unchanged."));
}

async function pxMonoDlg() {
  if (!ed.doc || ed.doc.channels < 2) return;
  const html = `<div class="dfield"><span>${esc(t("Channels"))}</span>${segHtml("mode", [["mix", "Mix both"], ["left", "Left only"], ["right", "Right only"]], "mix")}</div>`
    + `<div class="dnote">${esc(t("Studio makes a new mono file from this one, with your edits and locations. This file stays as it is."))}</div>`;
  const v = await askForm(t("New mono file"), html, { ok: t("make"), setup: segSetup, read: () => segRead(document.querySelector("#dlg .dform")) });
  if (!v) return;
  return pxNewFile(["mix", "left", "right"].includes(v.mode) ? v.mode : "mix");
}

function pxBoxes() {
  if (!ed.doc || ed.editing && !px.fade) return [];
  const F = ed.doc.frames, z = px.fade, W = viewWidth();
  const xi = xOf(z && z.kind === "in" ? z.len : 0), xo = xOf(F - (z && z.kind === "out" ? z.len : 0));
  const out = [];
  if (xi > -PX_BOX && xi < W) out.push({ kind: "in", x0: xi, x1: xi + PX_BOX });
  if (xo > 0 && xo < W + PX_BOX) out.push({ kind: "out", x0: xo - PX_BOX, x1: xo });
  return out;
}

function pxLabelX() {
  const xi = ed.doc ? xOf(0) : -Infinity;
  return xi > -PX_BOX - 6 && xi < viewWidth() ? Math.max(6, xi + PX_BOX + 5) : 6;
}

function pxHit(p, touch) {
  const slack = touch ? 14 : 3;
  if (!ed.doc || ed.editing || p.y > PX_TOP + PX_BOX + slack + 1) return null;
  for (const b of pxBoxes()) if (p.x >= b.x0 - slack && p.x <= b.x1 + slack) return b.kind;
  return null;
}

function pxDown(e, cv, p) {
  const kind = pxHit(p, e.pointerType === "touch");
  if (!kind) return false;
  e.preventDefault();
  cv.setPointerCapture(e.pointerId);
  const F = ed.doc.frames;
  px.drag = { kind, y0: p.y, dx: kind === "in" ? p.x - xOf(0) : p.x - xOf(F), pid: e.pointerId, ctrl: e.ctrlKey || e.metaKey, moved: false };
  px.fade = { kind, len: 0, shape: px.drag.ctrl ? "cos" : "lin", k: 0 };
  redraw();
  return true;
}

function pxMove(e, p) {
  const d = px.drag;
  if (!d) return;
  const F = ed.doc.frames, f = Math.round(Math.max(0, Math.min(F, frameAt(Math.max(0, Math.min(viewWidth(), p.x - d.dx))))));
  const dy = p.y - d.y0, k = Math.abs(dy) <= PX_DEAD ? 0 : Math.max(-1, Math.min(1, -Math.sign(dy) * (Math.abs(dy) - PX_DEAD) / PX_SPAN));
  d.ctrl = e.ctrlKey || e.metaKey;
  d.moved = true;
  px.fade = { kind: d.kind, len: d.kind === "in" ? f : F - f, shape: d.ctrl ? "cos" : "lin", k: Math.round(k * 100) / 100 };
  redraw();
}

function pxUp() {
  const d = px.drag, z = px.fade;
  px.drag = null;
  if (!d || !z || z.len < 2) { px.fade = null; redraw(); return; }
  const F = ed.doc.frames;
  pxRun(z.kind === "in" ? "fadein" : "fadeout", { ra: z.kind === "in" ? 0 : F - z.len, rb: z.kind === "in" ? z.len : F, chans: new Array(ed.doc.channels).fill(true), cfg: { shape: z.shape, k: z.k } });
}

function pxCancel() {
  if (!px.drag) return;
  px.drag = null;
  px.fade = null;
  redraw();
}

function drawFade(g, W, H, dpr) {
  if (!ed.doc) return;
  const z = px.fade, F = ed.doc.frames;
  if (z && z.len > 0) {
    const a = z.kind === "in" ? 0 : F - z.len, b = z.kind === "in" ? z.len : F;
    const x0 = Math.max(0, Math.floor(xOf(a) * dpr)), x1 = Math.min(W, Math.ceil(xOf(b) * dpr));
    const pad = 2 * dpr, span = H - 2 * pad;
    if (x1 > x0) {
      g.beginPath();
      for (let x = x0; x <= x1; x++) {
        const y = pad + (1 - pxGain(frameAt(x / dpr))) * span;
        if (x === x0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.lineTo(x1, 0);
      g.lineTo(x0, 0);
      g.closePath();
      g.fillStyle = tc("gold", 0.07);
      g.fill();
      g.beginPath();
      for (let x = x0; x <= x1; x++) {
        const y = pad + (1 - pxGain(frameAt(x / dpr))) * span;
        if (x === x0) g.moveTo(x, y); else g.lineTo(x, y);
      }
      g.strokeStyle = TH.gold;
      g.lineWidth = Math.max(1, 1.5 * dpr);
      g.stroke();
    }
  }
  const boxes = pxBoxes(), s = PX_BOX * dpr, top = PX_TOP * dpr;
  for (const bx of boxes) {
    const x = Math.round(bx.x0 * dpr), on = (px.drag && px.drag.kind === bx.kind) || px.hover === bx.kind;
    g.fillStyle = on ? TH.ink : tc("gold", 0.85);
    g.fillRect(x, top, s, s);
    g.strokeStyle = TH.canvas;
    g.lineWidth = Math.max(1, dpr);
    g.strokeRect(x + 0.5, top + 0.5, s - 1, s - 1);
    if (!z || z.kind !== bx.kind || !(z.len > 0)) continue;
    const text = t(bx.kind === "in" ? "Fade in" : "Fade out") + " · " + fmtTime(z.len) + " · " + pxCurveName(z.shape, z.k);
    g.font = thFont(10, dpr);
    g.textBaseline = "middle";
    const tw0 = g.measureText(text).width, padX = 5 * dpr;
    let lx = bx.kind === "in" ? x + s + 6 * dpr : x - 6 * dpr - tw0 - 2 * padX;
    lx = Math.max(2 * dpr, Math.min(W - tw0 - 2 * padX - 2 * dpr, lx));
    const ly = top + s + 6 * dpr;
    g.fillStyle = tc("dark", 0.85);
    g.fillRect(lx, ly, tw0 + 2 * padX, 16 * dpr * thFs());
    g.fillStyle = TH.ink;
    g.textAlign = "left";
    g.fillText(text, lx + padX, ly + 8 * dpr * thFs());
  }
}

function pxKeys(e) {
  if (px.drag) {
    if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); pxCancel(); return; }
    if ((e.key === "Control" || e.key === "Meta") && px.fade) { px.drag.ctrl = e.type === "keydown"; px.fade = Object.assign({}, px.fade, { shape: px.drag.ctrl ? "cos" : "lin" }); redraw(); }
    return;
  }
  if (px.job && e.type === "keydown" && e.key === "Escape") { e.preventDefault(); e.stopPropagation(); ed.worker.postMessage({ t: "pxcancel" }); }
}

function wirePx() {
  document.addEventListener("keydown", pxKeys, true);
  document.addEventListener("keyup", pxKeys, true);
}

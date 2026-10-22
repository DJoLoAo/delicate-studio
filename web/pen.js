const PEN_SPP = 1, PEN_ZOOM = 0.25;

const pen = { on: false, stroke: null, hold: null, rev: 0 };

function penReady() { return !!ed.doc && ed.view.spp <= PEN_SPP; }

function penSet(on) {
  pen.on = !!on && !!ed.doc;
  if (!pen.on && pen.stroke) penCancel();
  $("penBtn").classList.toggle("on", pen.on);
  const cv = $("wv");
  if (cv) cv.style.cursor = pen.on ? (penReady() ? "crosshair" : "zoom-in") : "";
  const k = cmdKeyText("pencil");
  if (pen.on) flash(penReady() ? t("Pencil: draw on a channel to redraw its samples.") + (k ? " " + t("{key} switches back.").replace("{key}", k) : "") : t("Pencil: click the waveform to zoom in to sample level, then draw."));
  redraw();
}

function penToggle() { penSet(!pen.on); }

function penAmp(n) {
  if (ed.scale !== "db") return n;
  const a = Math.abs(n);
  if (a <= 0) return 0;
  const v = Math.pow(10, (a - 1) * DB_RANGE / 20);
  return n < 0 ? -v : v;
}

function penLane(cv, y) {
  const ch = ed.doc.channels, lh = cv.clientHeight / ch;
  return Math.max(0, Math.min(ch - 1, Math.floor(y / lh)));
}

function penValue(cv, c, y) {
  const lh = cv.clientHeight / ed.doc.channels, mid = c * lh + lh / 2, A = Math.max(1, lh / 2 - 3);
  return penAmp(Math.max(-1, Math.min(1, (mid - y) / A)));
}

function penAt(s, x, y) {
  const i = Math.max(s.v0, Math.min(s.v1 - 1, Math.round(frameAt(x))));
  const v = penValue($("wv"), s.ch, y);
  const l = s.last;
  if (!l || l.i === i) s.vals[i - s.v0] = v;
  else {
    const d = i > l.i ? 1 : -1;
    for (let j = l.i + d; d > 0 ? j <= i : j >= i; j += d) s.vals[j - s.v0] = l.v + (v - l.v) * (j - l.i) / (i - l.i);
  }
  s.a = s.a === null ? i : Math.min(s.a, i);
  s.b = s.b === null ? i : Math.max(s.b, i);
  s.last = { i, v };
  pen.rev++;
}

function penDown(e, cv, p) {
  if (!pen.on || !ed.doc) return false;
  e.preventDefault();
  if (!penReady()) {
    zoomAt(PEN_ZOOM / ed.view.spp, frameAt(p.x));
    cv.style.cursor = "crosshair";
    flash(t("Zoomed in to sample level. Draw on a channel to redraw its samples."));
    return true;
  }
  if (ed.editing) return true;
  cv.setPointerCapture(e.pointerId);
  const F = ed.doc.frames, v0 = Math.max(0, Math.floor(ed.view.start)), v1 = Math.min(F, Math.ceil(ed.view.start + viewWidth() * ed.view.spp) + 1);
  if (v1 <= v0) return true;
  pen.hold = null;
  pen.stroke = { ch: penLane(cv, p.y), v0, v1, vals: new Float32Array(v1 - v0), a: null, b: null, last: null, raw: ed.raw };
  penAt(pen.stroke, p.x, p.y);
  redraw();
  return true;
}

function penMove(e, cv) {
  const s = pen.stroke;
  if (!s) return;
  const r = cv.getBoundingClientRect();
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
  for (const ev of list.length ? list : [e]) penAt(s, ev.clientX - r.left, ev.clientY - r.top);
  redraw();
}

function penCancel() {
  pen.stroke = null;
  pen.rev++;
  redraw();
}

async function penUp() {
  const s = pen.stroke;
  if (!s || s.a === null) { penCancel(); return; }
  const data = s.vals.slice(s.a - s.v0, s.b - s.v0 + 1);
  pen.stroke = null;
  pen.hold = { ch: s.ch, v0: s.v0, vals: s.vals, a: s.a, b: s.b, raw: s.raw || ed.raw };
  const r = await runEdit({ t: "edit", op: "pencil", pc: s.ch, pa: s.a, data }, false, true);
  if (!r) { pen.hold = null; redraw(); return; }
  flash(data.length === 1 ? t("1 sample redrawn") : t("{n} samples redrawn").replace("{n}", data.length.toLocaleString()));
}

function penKey() {
  return pen.on + ":" + pen.rev + ":" + (pen.hold ? "h" : "");
}

function penOver(c) {
  if (pen.hold && ed.raw && ed.raw.ver === ed.ver) pen.hold = null;
  const s = pen.stroke || pen.hold;
  return s && s.ch === c && s.a !== null ? s : null;
}

function penVal(s, i, v) {
  return s && i >= s.a && i <= s.b ? s.vals[i - s.v0] : v;
}

function penRaw(a, b) {
  const h = pen.hold;
  if (!h) return null;
  const r = h.raw;
  return r && r.id === ed.doc.id && a >= r.start && b <= r.start + r.count ? r : null;
}

function wirePen() {
  $("penBtn").classList.toggle("on", pen.on);
}

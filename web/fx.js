const FX_MAX_BANDS = 8;
const FX_TYPES = [{ v: "bell", label: "Bell" }, { v: "lowshelf", label: "Low shelf" }, { v: "highshelf", label: "High shelf" }, { v: "notch", label: "Notch" }];
const FX_FLAT = { hp: { on: false, f: 30, ord: 4 }, lp: { on: false, f: 18000, ord: 4 }, bands: [], comp: { on: false, thr: -18, ratio: 3, knee: 6, att: 5, rel: 150, makeup: 0 }, lim: { on: false, ceil: -1, look: 2, rel: 100 }, out: 0, bpm: 120, mod: { mode: "off", rate: 0.5, depth: 0.5, fb: 0.5, mix: 0.5 }, delay: { on: false, ms: 250, fb: 0.45, mix: 0.35, pp: false, note: "free" }, rev: { on: false, decay: 2, damp: 0.5, pre: 10, mix: 0.25, cut: 180 }, gate: { on: false, rate: 4, depth: 1, square: true, note: "free" }, ds: { on: false, f: 6500, thr: -30, range: 6 } };
const FX_MODS = [{ v: "off", label: "Off" }, { v: "chorus", label: "Chorus" }, { v: "flanger", label: "Flanger" }, { v: "phaser", label: "Phaser" }];
const FX_NOTES = [{ v: "free", label: "free" }, { v: "1/16", label: "1/16" }, { v: "1/8", label: "1/8" }, { v: "3/16", label: "1/8 dotted" }, { v: "1/4", label: "1/4" }, { v: "3/8", label: "1/4 dotted" }, { v: "1/2", label: "1/2" }, { v: "3/4", label: "1/2 dotted" }, { v: "1/1", label: "1 bar" }];
const FX_FACTORY = [
  { v: "flat", label: "Flat", cfg: {} },
  { v: "deck", label: "DJ deck EQ", cfg: { bands: [{ type: "lowshelf", f: 200, g: 0, q: 0.7071068 }, { type: "bell", f: 1000, g: 0, q: 0.7 }, { type: "highshelf", f: 2500, g: 0, q: 0.7071068 }] } },
  { v: "mic", label: "DJ mic voice", cfg: { hp: { on: true, f: 100, ord: 2 }, comp: { on: true, thr: -18, ratio: 3, knee: 6, att: 5, rel: 150, makeup: 3 } } },
  { v: "deess", label: "Vocal de-esser", cfg: { hp: { on: true, f: 80, ord: 2 }, ds: { on: true, f: 6500, thr: -30, range: 8 } } },
  { v: "atmo", label: "Room mic (atmo)", cfg: { hp: { on: true, f: 200, ord: 2 } } },
  { v: "master", label: "DJ master limiter", cfg: { lim: { on: true, ceil: -1, look: 1, rel: 100 } } },
  { v: "rumble", label: "Vinyl rumble cut", cfg: { hp: { on: true, f: 25, ord: 4 } } },
  { v: "fecho", label: "Navidrome echo", cfg: { delay: { on: true, ms: 250, fb: 0.5, mix: 0.4 } } },
  { v: "frev", label: "Navidrome reverb", cfg: { rev: { on: true, decay: 2, damp: 0.3, pre: 0, mix: 0.35, cut: 20 } } },
  { v: "fchorus", label: "Navidrome chorus", cfg: { mod: { mode: "chorus", rate: 0.8, depth: 1, fb: 0, mix: 0.5 } } },
  { v: "fgate", label: "Navidrome gater", cfg: { gate: { on: true, rate: 4, depth: 0.8, square: true } } },
  { v: "ddelay", label: "DJ deck delay", cfg: { bpm: 120, delay: { on: true, ms: 250, fb: 0.45, mix: 0.35, note: "1/8" } } },
  { v: "drev", label: "DJ deck reverb", cfg: { rev: { on: true, decay: 3, damp: 0.5, pre: 10, mix: 0.3, cut: 180 } } },
  { v: "dflanger", label: "DJ deck flanger", cfg: { mod: { mode: "flanger", rate: 1.3, depth: 0.7, fb: 0.6, mix: 0.5 } } },
  { v: "dphaser", label: "DJ deck phaser", cfg: { mod: { mode: "phaser", rate: 1.05, depth: 1, fb: 0.35, mix: 0.5 } } },
  { v: "glue", label: "Mastering glue", cfg: { hp: { on: true, f: 20, ord: 2 }, comp: { on: true, thr: -14, ratio: 2, knee: 6, att: 30, rel: 200, makeup: 2 }, lim: { on: true, ceil: -1, look: 2, rel: 100 } } }
];
const fx = { target: null, edCfg: null, commitT: 0, cfg: null, preset: "flat", match: true, listen: "off", band: 0, job: null, seq: 0, busy: false, again: false, done: null, err: null, meter: { comp: 0, lim: 0, match: 0, ds: 0 }, poll: 0, drag: null, user: [] };

function fxClone(v) { return JSON.parse(JSON.stringify(v)); }

function fxMake(part) {
  const p = part || {};
  const c = fxClone(FX_FLAT);
  for (const k of ["hp", "lp", "comp", "lim", "mod", "delay", "rev", "gate", "ds"]) if (p[k]) Object.assign(c[k], p[k]);
  if (Number.isFinite(Number(p.bpm))) c.bpm = Math.max(40, Math.min(240, Number(p.bpm)));
  fxSync(c);
  if (Array.isArray(p.bands)) c.bands = p.bands.slice(0, FX_MAX_BANDS).map(b => ({ on: b.on !== false, type: FX_TYPES.some(t => t.v === b.type) ? b.type : "bell", f: Number(b.f) || 1000, g: Number(b.g) || 0, q: Number(b.q) || 0.7071068 }));
  if (Number.isFinite(Number(p.out))) c.out = Number(p.out);
  return c;
}

function fxBeats(note) { if (!note || note === "free") return 0; const [a, b] = note.split("/").map(Number); return a / b * 4; }

function fxSync(c) {
  const d = fxBeats(c.delay.note), g = fxBeats(c.gate.note), beat = 60000 / c.bpm;
  if (d) c.delay.ms = Math.min(2000, Math.round(beat * d * 10) / 10);
  if (g) c.gate.rate = Math.round(1000 / (beat * g) * 1000) / 1000;
}

function fxUserKey() { return "studioFxPresets:" + (studio.me ? studio.me.username : ""); }

function fxLoad() {
  let v = null, u = null;
  try { v = JSON.parse(localStorage.getItem("studioFx") || "null"); } catch {}
  try { u = JSON.parse(localStorage.getItem(fxUserKey()) || "null"); } catch {}
  fx.cfg = fxMake(v && v.cfg);
  fx.preset = v && typeof v.preset === "string" ? v.preset : "flat";
  fx.match = !(v && v.match === false);
  fx.user = Array.isArray(u) ? u.filter(p => p && typeof p.name === "string" && p.cfg).map(p => ({ name: p.name, cfg: fxMake(p.cfg) })) : [];
  fx.band = Math.min(fx.band, Math.max(0, fx.cfg.bands.length - 1));
}

function fxSave() {
  if (fx.target) return;
  try { localStorage.setItem("studioFx", JSON.stringify({ cfg: fx.cfg, preset: fx.preset, match: fx.match })); } catch {}
}

function fxSaveUser() {
  try { localStorage.setItem(fxUserKey(), JSON.stringify(fx.user)); } catch {}
}

function fxWire() { return Object.assign(fxClone(fx.cfg), { match: fx.match }); }

function fxRange() {
  if (selOn()) return { a: ed.sel.a, b: ed.sel.b, sel: true };
  return { a: 0, b: ed.doc ? ed.doc.frames : 0, sel: false };
}

function fxShow() {
  fxPresetsUi();
  fxRender();
  if (!fx.job && fx.listen === "off") fxListen("proc");
}

function fxHide() {
  if (fx.listen !== "off") fxListen("off");
}

function fxDoc() {
  fx.done = null;
  fx.err = null;
  fx.listen = "off";
  if (rp.open && rp.tab === "fx") fxShow();
}

function fxSend() {
  if (!ed.doc) return;
  if (fx.busy) { fx.again = true; return; }
  fx.busy = true;
  call({ t: "fxcfg", kind: "rk", cfg: fxWire(), mode: fx.listen })
    .catch(e => { fx.listen = "off"; fx.err = String(e.message || e); fxRender(); })
    .finally(() => { fx.busy = false; if (fx.again) { fx.again = false; fxSend(); } });
}

function fxListen(mode) {
  fx.listen = mode;
  document.querySelectorAll("#fxListen button").forEach(b => b.classList.toggle("on", b.dataset.v === mode));
  fx.meter = { comp: 0, lim: 0, match: 0, ds: 0 };
  clearInterval(fx.poll);
  if (mode === "proc") fx.poll = setInterval(fxPoll, 100);
  fxSend();
  fxMeters();
}

async function fxPoll() {
  if (!rp.open || rp.tab !== "fx" || (!fx.target && fx.listen !== "proc")) { clearInterval(fx.poll); return; }
  if (!(fx.target ? ses.play.on : ed.play.on)) { fx.meter.comp *= 0.7; fx.meter.lim *= 0.7; fxMeters(); return; }
  try {
    const r = await call(fx.target ? { t: "rkmeter", ses: fxSesKey() } : { t: "rkmeter" });
    if (!r.on) return;
    fx.meter.comp = Math.max(r.comp, fx.meter.comp * 0.8);
    fx.meter.lim = Math.max(r.lim, fx.meter.lim * 0.8);
    fx.meter.ds = Math.max(r.ds || 0, fx.meter.ds * 0.8);
    fx.meter.match = r.match;
    fxMeters();
  } catch {}
}

function fxChanged(keepPreset) {
  if (!keepPreset) fx.preset = "";
  fxSync(fx.cfg);
  if (fx.target) { fxSesWrite(keepPreset); fxRender(); return; }
  fxSave();
  fxRender();
  if (fx.listen !== "off") fxSend();
}

function fxCoefs(type, sr, f, g, q) {
  f = Math.max(10, Math.min(sr * 0.49, f));
  q = Math.max(0.1, Math.min(40, q));
  const A = Math.pow(10, g / 40), w = 2 * Math.PI * f / sr, sn = Math.sin(w), cs = Math.cos(w), al = sn / (2 * q), s = 2 * Math.sqrt(A) * al;
  let b, a;
  if (type === "lowshelf") { b = [A * ((A + 1) - (A - 1) * cs + s), 2 * A * ((A - 1) - (A + 1) * cs), A * ((A + 1) - (A - 1) * cs - s)]; a = [(A + 1) + (A - 1) * cs + s, -2 * ((A - 1) + (A + 1) * cs), (A + 1) + (A - 1) * cs - s]; }
  else if (type === "highshelf") { b = [A * ((A + 1) + (A - 1) * cs + s), -2 * A * ((A - 1) + (A + 1) * cs), A * ((A + 1) + (A - 1) * cs - s)]; a = [(A + 1) - (A - 1) * cs + s, 2 * ((A - 1) - (A + 1) * cs), (A + 1) - (A - 1) * cs - s]; }
  else if (type === "notch") { b = [1, -2 * cs, 1]; a = [1 + al, -2 * cs, 1 - al]; }
  else if (type === "lp") { b = [(1 - cs) / 2, 1 - cs, (1 - cs) / 2]; a = [1 + al, -2 * cs, 1 - al]; }
  else if (type === "hp") { b = [(1 + cs) / 2, -(1 + cs), (1 + cs) / 2]; a = [1 + al, -2 * cs, 1 - al]; }
  else { b = [1 + al * A, -2 * cs, 1 - al * A]; a = [1 + al / A, -2 * cs, 1 - al / A]; }
  return [b[0] / a[0], b[1] / a[0], b[2] / a[0], a[1] / a[0], a[2] / a[0]];
}

function fxButterQs(ord) {
  const out = [];
  for (let k = 1; k <= ord / 2; k++) out.push(1 / (2 * Math.cos(Math.PI * (2 * k - 1) / (2 * ord))));
  return out;
}

function fxSections(c, sr) {
  const sec = [];
  if (c.hp.on) for (const q of fxButterQs(c.hp.ord)) sec.push(fxCoefs("hp", sr, c.hp.f, 0, q));
  if (c.lp.on) for (const q of fxButterQs(c.lp.ord)) sec.push(fxCoefs("lp", sr, c.lp.f, 0, q));
  for (const b of c.bands) if (b.on && (b.type === "notch" || Math.abs(b.g) > 1e-9)) sec.push(fxCoefs(b.type, sr, b.f, b.g, b.q));
  return sec;
}

function fxResp(sec, sr, f) {
  const w = 2 * Math.PI * f / sr, c1 = Math.cos(w), s1 = Math.sin(w), c2 = Math.cos(2 * w), s2 = Math.sin(2 * w);
  let m = 1;
  for (const k of sec) {
    const nr = k[0] + k[1] * c1 + k[2] * c2, ni = -(k[1] * s1 + k[2] * s2), dr = 1 + k[3] * c1 + k[4] * c2, di = -(k[3] * s1 + k[4] * s2);
    m *= Math.sqrt((nr * nr + ni * ni) / (dr * dr + di * di));
  }
  return 20 * Math.log10(Math.max(1e-12, m));
}

function fxGeom() {
  const cv = $("fxGraph"), W = cv.clientWidth, H = cv.clientHeight, sr = fx.target ? ssRate() : ed.doc ? ed.doc.sampleRate : 48000;
  const g = { W, H, L: 30, R: 8, T: 8, B: 15, lo: 20, hi: Math.min(20000, sr * 0.49), sr };
  g.iw = Math.max(10, W - g.L - g.R);
  g.ih = Math.max(10, H - g.T - g.B);
  const top = fx.cfg.bands.reduce((m, b) => Math.max(m, Math.abs(b.g)), 0);
  g.span = top > 18 ? 30 : top > 12 ? 18 : 12;
  g.xf = f => g.L + (Math.log(Math.max(g.lo, f)) - Math.log(g.lo)) / (Math.log(g.hi) - Math.log(g.lo)) * g.iw;
  g.fx = x => Math.exp(Math.log(g.lo) + Math.max(0, Math.min(1, (x - g.L) / g.iw)) * (Math.log(g.hi) - Math.log(g.lo)));
  g.yd = v => g.T + (1 - (Math.max(-g.span, Math.min(g.span, v)) + g.span) / (2 * g.span)) * g.ih;
  g.dy = y => g.span - Math.max(0, Math.min(1, (y - g.T) / g.ih)) * 2 * g.span;
  return g;
}

function fxHandle(b, g) {
  return { x: g.xf(b.f), y: b.type === "notch" ? g.yd(-g.span * 0.8) : g.yd(b.g) };
}

function fxDraw() {
  const cv = $("fxGraph");
  if (!cv || !rp.open || rp.tab !== "fx") return;
  const dpr = window.devicePixelRatio || 1, g = fxGeom(), W = g.W, H = g.H;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const x = cv.getContext("2d");
  x.setTransform(dpr, 0, 0, dpr, 0, 0);
  x.clearRect(0, 0, W, H);
  x.fillStyle = TH.graph;
  x.fillRect(g.L, g.T, g.iw, g.ih);
  x.font = thFont(9);
  x.lineWidth = 1;
  x.textBaseline = "middle";
  x.textAlign = "right";
  const step = g.span > 18 ? 10 : 6;
  for (let v = -g.span; v <= g.span; v += step) {
    const y = Math.round(g.yd(v)) + 0.5;
    x.strokeStyle = tw(v === 0 ? 0.16 : 0.06);
    x.beginPath(); x.moveTo(g.L, y); x.lineTo(g.L + g.iw, y); x.stroke();
    x.fillStyle = TH.glabel;
    x.fillText((v > 0 ? "+" : "") + v, g.L - 4, y);
  }
  x.textAlign = "center";
  x.textBaseline = "alphabetic";
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f > g.hi) continue;
    const xx = Math.round(g.xf(f)) + 0.5;
    x.strokeStyle = tw(0.06);
    x.beginPath(); x.moveTo(xx, g.T); x.lineTo(xx, g.T + g.ih); x.stroke();
    x.fillStyle = TH.glabel;
    x.fillText(f >= 1000 ? f / 1000 + "k" : String(f), xx, H - 3);
  }
  x.save();
  x.beginPath();
  x.rect(g.L, g.T, g.iw, g.ih);
  x.clip();
  const c = fx.cfg, sb = c.bands[fx.band];
  if (sb && sb.on) {
    const one = fxSections({ hp: { on: false }, lp: { on: false }, bands: [sb] }, g.sr);
    x.fillStyle = tc("gblue", 0.12);
    x.beginPath();
    x.moveTo(g.L, g.yd(0));
    for (let i = 0; i <= 300; i++) { const f = g.lo * Math.pow(g.hi / g.lo, i / 300); x.lineTo(g.xf(f), g.yd(fxResp(one, g.sr, f))); }
    x.lineTo(g.L + g.iw, g.yd(0));
    x.closePath();
    x.fill();
  }
  const sec = fxSections(c, g.sr);
  x.strokeStyle = TH.gblue;
  x.lineWidth = 1.6;
  x.beginPath();
  for (let i = 0; i <= 360; i++) { const f = g.lo * Math.pow(g.hi / g.lo, i / 360), px = g.xf(f), py = g.yd(fxResp(sec, g.sr, f) + c.out); if (i) x.lineTo(px, py); else x.moveTo(px, py); }
  x.stroke();
  x.restore();
  x.textAlign = "center";
  x.textBaseline = "middle";
  x.font = thFont(8);
  c.bands.forEach((b, i) => {
    const h = fxHandle(b, g), on = i === fx.band;
    x.beginPath();
    x.arc(h.x, h.y, on ? 7 : 6, 0, Math.PI * 2);
    x.fillStyle = b.on ? (on ? TH.gblue : tc("gblue", 0.55)) : tw(0.18);
    x.fill();
    if (on) { x.strokeStyle = tw(0.9); x.lineWidth = 1.2; x.stroke(); }
    x.fillStyle = "#0b0b0b";
    x.fillText(String(i + 1), h.x, h.y + 0.5);
  });
}

function fxBandAdd(f, gdb) {
  const c = fx.cfg;
  if (c.bands.length >= FX_MAX_BANDS) return;
  c.bands.push({ on: true, type: "bell", f: Math.round(f || 1000), g: Math.round((gdb || 0) * 10) / 10, q: 1 });
  fx.band = c.bands.length - 1;
  fxChanged();
}

function fxBandDel() {
  const c = fx.cfg;
  if (!c.bands[fx.band]) return;
  c.bands.splice(fx.band, 1);
  fx.band = Math.max(0, Math.min(fx.band, c.bands.length - 1));
  fxChanged();
}

function fxGraphWire() {
  const cv = $("fxGraph");
  const local = e => { const r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const hit = p => {
    const g = fxGeom();
    let best = -1, bd = 12;
    fx.cfg.bands.forEach((b, i) => { const h = fxHandle(b, g), d = Math.hypot(h.x - p.x, h.y - p.y); if (d < bd) { bd = d; best = i; } });
    return best;
  };
  cv.addEventListener("pointerdown", e => {
    const p = local(e), i = hit(p);
    if (i < 0) return;
    fx.band = i;
    fx.drag = { id: e.pointerId };
    cv.setPointerCapture(e.pointerId);
    fxRender();
  });
  cv.addEventListener("pointermove", e => {
    if (!fx.drag || fx.drag.id !== e.pointerId) return;
    const p = local(e), g = fxGeom(), b = fx.cfg.bands[fx.band];
    if (!b) return;
    b.f = Math.round(g.fx(p.x));
    if (b.type !== "notch") b.g = Math.round(g.dy(p.y) * 10) / 10;
    fxChanged();
  });
  const end = e => { if (fx.drag && fx.drag.id === e.pointerId) fx.drag = null; };
  cv.addEventListener("pointerup", end);
  cv.addEventListener("pointercancel", end);
  cv.addEventListener("dblclick", e => {
    const p = local(e), i = hit(p);
    if (i >= 0) { fx.band = i; fxBandDel(); return; }
    const g = fxGeom();
    fxBandAdd(g.fx(p.x), g.dy(p.y));
  });
  cv.addEventListener("wheel", e => {
    const b = fx.cfg.bands[fx.band];
    if (!b || hit(local(e)) !== fx.band) return;
    e.preventDefault();
    b.q = Math.round(Math.max(0.1, Math.min(40, b.q * Math.pow(1.1, e.deltaY < 0 ? 1 : -1))) * 100) / 100;
    fxChanged();
  }, { passive: false });
}

function fxPresetItems() {
  return FX_FACTORY.map(p => ({ v: p.v, label: p.label })).concat(fx.user.map((p, i) => ({ v: "u" + i, label: p.name })));
}

function fxDd(el, items, onPick) {
  const list = el.querySelector(".list");
  list.innerHTML = "";
  for (const it of items) {
    const d = document.createElement("div");
    d.className = "ddi";
    d.textContent = t(it.label);
    d.dataset.v = it.v;
    d.addEventListener("click", ev => { ev.stopPropagation(); el.classList.remove("open"); onPick(it.v); });
    list.appendChild(d);
  }
  if (el.dataset.wired) return;
  el.dataset.wired = "1";
  el.querySelector(".cur").addEventListener("click", ev => { ev.stopPropagation(); document.querySelectorAll(".dd.open").forEach(o => { if (o !== el) o.classList.remove("open"); }); el.classList.toggle("open"); });
}

function fxPresetsUi() {
  fxDd($("fxPreset"), [{ v: "", label: "Custom" }].concat(fxPresetItems()), v => {
    if (!v) return;
    const f = FX_FACTORY.find(p => p.v === v), u = /^u\d+$/.test(v) ? fx.user[Number(v.slice(1))] : null;
    if (!f && !u) return;
    fx.cfg = fxMake(f ? f.cfg : u.cfg);
    fx.preset = v;
    fx.band = 0;
    fxChanged(true);
  });
}

async function fxPresetSave() {
  const name = String((await askText(t("Save preset"), fx.preset && /^u\d+$/.test(fx.preset) ? fx.user[Number(fx.preset.slice(1))].name : "", { message: t("Your presets are kept in this browser for your account.") })) || "").trim().slice(0, 60);
  if (!name) return;
  const at = fx.user.findIndex(p => p.name === name);
  const p = { name, cfg: fxClone(fx.cfg) };
  if (at >= 0) fx.user[at] = p; else fx.user.push(p);
  fx.preset = "u" + (at >= 0 ? at : fx.user.length - 1);
  fxSaveUser();
  fxSave();
  fxPresetsUi();
  fxRender();
}

async function fxPresetDel() {
  if (!/^u\d+$/.test(fx.preset)) return;
  const i = Number(fx.preset.slice(1)), p = fx.user[i];
  if (!p || !(await ask(t("Delete preset?"), p.name, { ok: t("delete") }))) return;
  fx.user.splice(i, 1);
  fx.preset = "";
  fxSaveUser();
  fxSave();
  fxPresetsUi();
  fxRender();
}

function fxDb(v, digits) { return (v > 0 ? "+" : v < 0 ? "−" : "") + Math.abs(v).toFixed(digits === undefined ? 1 : digits) + " dB"; }
function fxHz(f) { return f >= 1000 ? (Math.round(f / 10) / 100).toFixed(f >= 10000 ? 1 : 2) + " kHz" : Math.round(f) + " Hz"; }
function fxMs(v) { return (v < 10 ? v.toFixed(1) : Math.round(v)) + " ms"; }

function fxMeters() {
  const bar = (id, db) => { const el = $(id); if (el) el.querySelector("i").style.width = Math.min(100, db / 20 * 100) + "%"; };
  bar("fxCpGr", fx.meter.comp);
  bar("fxLmGr", fx.meter.lim);
  bar("fxDsGr", fx.meter.ds);
  if ($("fxDsGrV")) $("fxDsGrV").textContent = fx.meter.ds > 0.05 ? "−" + fx.meter.ds.toFixed(1) + " dB" : "";
  if ($("fxCpGrV")) $("fxCpGrV").textContent = fx.meter.comp > 0.05 ? "−" + fx.meter.comp.toFixed(1) + " dB" : "";
  if ($("fxLmGrV")) $("fxLmGrV").textContent = fx.meter.lim > 0.05 ? "−" + fx.meter.lim.toFixed(1) + " dB" : "";
  const m = $("fxMatchV");
  if (m) m.textContent = fx.match && fx.listen === "proc" && Math.abs(fx.meter.match) > 0.05 ? t("Processed turned by {d} to match").replace("{d}", fxDb(fx.meter.match)) : "";
}

function fxRender() {
  const c = fx.cfg;
  if (!c || !$("fxBody")) return;
  const r = fx.target ? { a: 0, b: 0, sel: false } : fxRange(), busy = !!fx.job;
  $("diag").classList.toggle("sesfx", !!fx.target);
  if (fx.target) {
    const h = fxSesHolder();
    $("fxTitle").textContent = fx.target.kind === "master" ? t("Master effects") : t("Effects on {n}").replace("{n}", h ? h.name : "");
    document.querySelectorAll("#fxByp button").forEach(x => x.classList.toggle("on", x.dataset.v === (h && h.fx && !h.fx.on ? "off" : "on")));
  }
  const pd = $("fxPreset"), items = [{ v: "", label: "Custom" }].concat(fxPresetItems()), it = items.find(i => i.v === fx.preset) || items[0];
  pd.querySelector(".cur").textContent = t(it.label);
  pd.dataset.v = it.v;
  $("fxDel").classList.toggle("hidden", !/^u\d+$/.test(fx.preset));
  const chips = c.bands.map((b, i) => `<button class="segbtn${i === fx.band ? " on" : ""}${b.on ? "" : " off"}" data-i="${i}">${i + 1}</button>`).join("");
  $("fxBandChips").innerHTML = chips + (c.bands.length < FX_MAX_BANDS ? `<button class="segbtn" data-i="add" title="${esc(t("Add a band"))}">+</button>` : "");
  const b = c.bands[fx.band];
  $("fxBandRow").classList.toggle("hidden", !b);
  if (b) {
    const td = $("fxType");
    td.querySelector(".cur").textContent = t(FX_TYPES.find(x => x.v === b.type).label);
    td.dataset.v = b.type;
    if (document.activeElement !== $("fxF")) $("fxF").value = Math.round(b.f);
    if (document.activeElement !== $("fxG")) $("fxG").value = b.g.toFixed(1);
    if (document.activeElement !== $("fxQ")) $("fxQ").value = b.q.toFixed(2);
    $("fxG").disabled = b.type === "notch";
    document.querySelectorAll("#fxBandOn button").forEach(x => x.classList.toggle("on", x.dataset.v === (b.on ? "on" : "off")));
  }
  const onoff = (id, v) => document.querySelectorAll("#" + id + " button").forEach(x => x.classList.toggle("on", x.dataset.v === (v ? "on" : "off")));
  onoff("fxHpOn", c.hp.on);
  onoff("fxLpOn", c.lp.on);
  onoff("fxCpOn", c.comp.on);
  onoff("fxLmOn", c.lim.on);
  if (document.activeElement !== $("fxHpF")) $("fxHpF").value = Math.round(c.hp.f);
  if (document.activeElement !== $("fxLpF")) $("fxLpF").value = Math.round(c.lp.f);
  document.querySelectorAll("#fxHpOrd button").forEach(x => x.classList.toggle("on", Number(x.dataset.v) === c.hp.ord));
  document.querySelectorAll("#fxLpOrd button").forEach(x => x.classList.toggle("on", Number(x.dataset.v) === c.lp.ord));
  const sl = (id, v, txt) => { $(id).value = v; $(id + "V").textContent = txt; };
  sl("fxThr", c.comp.thr, c.comp.thr.toFixed(1) + " dB");
  sl("fxRatio", c.comp.ratio, c.comp.ratio.toFixed(1) + ":1");
  sl("fxKnee", c.comp.knee, c.comp.knee.toFixed(0) + " dB");
  sl("fxAtt", c.comp.att, fxMs(c.comp.att));
  sl("fxRel", c.comp.rel, fxMs(c.comp.rel));
  sl("fxMakeup", c.comp.makeup, fxDb(c.comp.makeup));
  sl("fxCeil", c.lim.ceil, c.lim.ceil.toFixed(1) + " dBTP");
  sl("fxLmRel", c.lim.rel, fxMs(c.lim.rel));
  sl("fxLook", c.lim.look, fxMs(c.lim.look));
  sl("fxOut", c.out, fxDb(c.out));
  const pc = v => Math.round(v * 100) + " %";
  if (document.activeElement !== $("fxBpm")) $("fxBpm").value = String(Math.round(c.bpm * 100) / 100);
  document.querySelectorAll("#fxMdMode button").forEach(x => x.classList.toggle("on", x.dataset.v === c.mod.mode));
  sl("fxMdRate", c.mod.rate, c.mod.rate.toFixed(2) + " Hz");
  sl("fxMdDepth", Math.round(c.mod.depth * 100), pc(c.mod.depth));
  sl("fxMdFb", Math.round(c.mod.fb * 100), pc(c.mod.fb));
  sl("fxMdMix", Math.round(c.mod.mix * 100), pc(c.mod.mix));
  document.querySelectorAll("#fxBody .fxmd").forEach(el => el.classList.toggle("hidden", c.mod.mode === "off"));
  document.querySelectorAll("#fxBody .fxmdfb").forEach(el => el.classList.toggle("hidden", c.mod.mode === "off" || c.mod.mode === "chorus"));
  onoff("fxDlOn", c.delay.on);
  onoff("fxDlPp", c.delay.pp);
  fxNoteShow("fxDlNote", c.delay.note);
  if (document.activeElement !== $("fxDlMs")) $("fxDlMs").value = String(c.delay.ms);
  $("fxDlMs").disabled = c.delay.note !== "free";
  sl("fxDlFb", Math.round(c.delay.fb * 100), pc(c.delay.fb));
  sl("fxDlMix", Math.round(c.delay.mix * 100), pc(c.delay.mix));
  document.querySelectorAll("#fxBody .fxdl").forEach(el => el.classList.toggle("hidden", !c.delay.on));
  onoff("fxRvOn", c.rev.on);
  sl("fxRvDecay", c.rev.decay, c.rev.decay.toFixed(1) + " s");
  sl("fxRvDamp", Math.round(c.rev.damp * 100), pc(c.rev.damp));
  sl("fxRvPre", c.rev.pre, Math.round(c.rev.pre) + " ms");
  sl("fxRvCut", c.rev.cut, fxHz(c.rev.cut));
  sl("fxRvMix", Math.round(c.rev.mix * 100), pc(c.rev.mix));
  document.querySelectorAll("#fxBody .fxrv").forEach(el => el.classList.toggle("hidden", !c.rev.on));
  onoff("fxGtOn", c.gate.on);
  onoff("fxDsOn", c.ds.on);
  sl("fxDsF", c.ds.f, fxHz(c.ds.f));
  sl("fxDsThr", c.ds.thr, c.ds.thr.toFixed(1) + " dB");
  sl("fxDsRange", c.ds.range, c.ds.range.toFixed(1) + " dB");
  document.querySelectorAll("#fxBody .fxds").forEach(el => el.classList.toggle("hidden", !c.ds.on));
  document.querySelectorAll("#fxGtShape button").forEach(x => x.classList.toggle("on", x.dataset.v === (c.gate.square ? "square" : "sine")));
  fxNoteShow("fxGtNote", c.gate.note);
  if (document.activeElement !== $("fxGtRate")) $("fxGtRate").value = String(c.gate.rate);
  $("fxGtRate").disabled = c.gate.note !== "free";
  sl("fxGtDepth", Math.round(c.gate.depth * 100), pc(c.gate.depth));
  document.querySelectorAll("#fxBody .fxgt").forEach(el => el.classList.toggle("hidden", !c.gate.on));
  document.querySelectorAll("#fxBody .fxcp").forEach(el => el.classList.toggle("fxoff", !c.comp.on));
  document.querySelectorAll("#fxBody .fxlm").forEach(el => el.classList.toggle("fxoff", !c.lim.on));
  if (!fx.target) $("fxRange").textContent = (r.sel ? t("Selection") : t("Whole file")) + " · " + fmtTime(r.a) + "–" + fmtTime(r.b);
  document.querySelectorAll("#fxListen button").forEach(x => { x.disabled = x.dataset.v !== "off" && busy; x.classList.toggle("on", x.dataset.v === fx.listen); });
  document.querySelectorAll("#fxMatch button").forEach(x => x.classList.toggle("on", x.dataset.v === (fx.match ? "on" : "off")));
  $("fxApply").disabled = busy || !ed.doc || r.b <= r.a;
  $("fxCancel").classList.toggle("hidden", !busy);
  $("fxBar").classList.toggle("hidden", !busy);
  if (!busy) $("fxBar").querySelector("i").style.width = "0%";
  let sum;
  if (busy) sum = t("Processing…") + " " + Math.round(fx.job.frac * 100) + " %";
  else if (fx.err) sum = fx.err;
  else if (fx.done) sum = t("Applied to") + " " + fmtTime(fx.done.a) + "–" + fmtTime(fx.done.b) + ". " + t("Undo brings the original back.");
  else sum = t("Switch between Original and Processed while it plays. With Match levels on, Processed is turned to the loudness of the original, so you hear the change in sound and not just in level. Apply never matches levels.");
  $("fxSum").textContent = sum;
  fxMeters();
  fxDraw();
}

async function fxApply() {
  if (!ed.doc || fx.job) return;
  const r = fxRange();
  if (r.b <= r.a) return;
  const id = "e" + (++fx.seq);
  fx.job = { id, frac: 0 };
  fx.done = null;
  fx.err = null;
  if (fx.listen !== "off") fxListen("off");
  fxRender();
  try {
    const res = await runEdit({ t: "fxapply", kind: "rk", jobId: id, ra: r.a, rb: r.b, cfg: fxWire() }, false, true);
    if (res && res.hist) { fx.done = { a: r.a, b: r.b }; flash(t("Effects applied")); }
  } finally {
    fx.job = null;
    fxRender();
  }
}

function fxProg(m) {
  if (!fx.job || m.id !== fx.job.id) return;
  fx.job.frac = m.frac;
  $("fxBar").querySelector("i").style.width = Math.round(m.frac * 100) + "%";
  $("fxSum").textContent = t("Processing…") + " " + Math.round(m.frac * 100) + " %";
}

function fxAfterEdit() {
  if (rp.open && rp.tab === "fx") fxRender();
}

function fxNoteShow(id, v) {
  const el = $(id), it = FX_NOTES.find(n => n.v === v) || FX_NOTES[0];
  el.querySelector(".cur").textContent = t(it.label);
  el.dataset.v = it.v;
}

function fxTypePick(v) {
  const b = fx.cfg.bands[fx.band];
  if (!b) return;
  b.type = v;
  if (v !== "bell" && v !== "notch" && b.q > 2) b.q = 0.7071068;
  fxChanged();
}

function fxSesKey() { return fx.target.kind === "master" ? "master" : fx.target.id; }

function fxSesHolder() {
  if (!fx.target || !ses.s) return null;
  if (fx.target.kind === "master") { if (!ses.s.master) ses.s.master = { fx: null }; return Object.assign(ses.s.master, { name: t("Master") }); }
  return ses.s.tracks.find(x => x.id === fx.target.id) || null;
}

function fxSesWrite(now) {
  const h = fxSesHolder();
  if (!h) return;
  h.fx = { on: h.fx ? h.fx.on !== false : true, cfg: fxClone(fx.cfg) };
  fxSesPush(now);
}

function fxSesPush(now) {
  clearTimeout(fx.commitT);
  fx.commitT = 0;
  if (now) { ssCommit(); ed.worker.postMessage({ t: "sesmix", s: ses.s, flush: true }); return; }
  clearTimeout(ses.mixT);
  ses.mixT = setTimeout(() => { if (ses.s) ed.worker.postMessage({ t: "sesmix", s: ses.s, flush: true }); }, 30);
  fx.commitT = setTimeout(() => { fx.commitT = 0; if (ses.s && fx.target) ssCommit(); }, 500);
}

function fxSesOpen(target) {
  if (!ses.open) return;
  if (fx.target) fxSesClose();
  if (rp.open) closeDiag();
  fx.edCfg = { cfg: fx.cfg, preset: fx.preset, band: fx.band };
  fx.target = target;
  const h = fxSesHolder();
  if (!h) { fx.target = null; return; }
  fx.cfg = fxMake(h.fx ? h.fx.cfg : {});
  fx.preset = h.fx ? "" : "flat";
  fx.band = 0;
  const d = $("diag");
  $("ses").appendChild(d);
  fxSesPlace();
  rp.open = true;
  rp.tab = "fx";
  ["dgBody", "nrBody", "humBody", "ldBody", "mdBody", "trBody"].forEach(id => $(id).classList.add("hidden"));
  $("fxBody").classList.remove("hidden");
  d.classList.remove("hidden");
  fx.meter = { comp: 0, lim: 0, match: 0, ds: 0 };
  clearInterval(fx.poll);
  fx.poll = setInterval(fxPoll, 100);
  fxPresetsUi();
  fxRender();
  ssHeads();
}

function fxSesPlace() {
  const d = $("diag"), b = $("ses").getBoundingClientRect(), body = $("sesBody").getBoundingClientRect(), hd = $("ses").querySelector(".edhead").getBoundingClientRect();
  if (matchMedia("(max-width:760px)").matches) { d.style.top = ""; d.style.bottom = ""; return; }
  d.style.top = Math.round(hd.bottom - b.top) + 8 + "px";
  d.style.bottom = Math.round(b.bottom - body.bottom) + 8 + "px";
}

function fxSesSync() {
  if (!fx.target) return;
  const h = fxSesHolder();
  if (!h) { fxSesClose(); return; }
  fx.cfg = fxMake(h.fx ? h.fx.cfg : {});
  fx.band = Math.min(fx.band, Math.max(0, fx.cfg.bands.length - 1));
  fxRender();
}

function fxSesClose() {
  if (!fx.target) return;
  if (fx.commitT) { clearTimeout(fx.commitT); fx.commitT = 0; if (ses.s) ssCommit(); }
  fx.target = null;
  clearInterval(fx.poll);
  const d = $("diag");
  d.classList.add("hidden");
  d.classList.remove("sesfx");
  d.style.top = "";
  d.style.bottom = "";
  document.querySelector("#ed .wvwrap").appendChild(d);
  rp.open = false;
  if (fx.edCfg) { fx.cfg = fx.edCfg.cfg; fx.preset = fx.edCfg.preset; fx.band = fx.edCfg.band; fx.edCfg = null; }
  fxPresetsUi();
  if (ses.open) ssHeads();
}

function fxSesToggle(target) {
  if (fx.target && fx.target.kind === target.kind && fx.target.id === target.id) fxSesClose(); else fxSesOpen(target);
}

function toggleFx() {
  if (ses.open && !ed.doc) { fxSesToggle({ kind: "master" }); return; } if (rp.open && rp.tab === "fx") closeDiag(); else openRepair("fx"); }

function wireFx() {
  fxLoad();
  fxPresetsUi();
  fxDd($("fxType"), FX_TYPES, fxTypePick);
  fxGraphWire();
  const num = (id, get, set, lo, hi) => {
    const el = $(id);
    const apply = () => {
      const v = Number(String(el.value).replace(",", ".").replace("−", "-"));
      if (Number.isFinite(v) && get()) { set(Math.max(lo, Math.min(hi, v))); fxChanged(); } else fxRender();
    };
    el.addEventListener("change", apply);
    el.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); el.blur(); } e.stopPropagation(); });
  };
  const band = () => fx.cfg.bands[fx.band];
  num("fxF", band, v => { band().f = v; }, 20, 22000);
  num("fxG", band, v => { band().g = v; }, -30, 30);
  num("fxQ", band, v => { band().q = v; }, 0.1, 40);
  num("fxHpF", () => true, v => { fx.cfg.hp.f = v; }, 10, 2000);
  num("fxLpF", () => true, v => { fx.cfg.lp.f = v; }, 1000, 24000);
  const seg = (id, fn) => $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; fn(b.dataset.v); fxChanged(); });
  seg("fxHpOn", v => { fx.cfg.hp.on = v === "on"; });
  seg("fxLpOn", v => { fx.cfg.lp.on = v === "on"; });
  seg("fxHpOrd", v => { fx.cfg.hp.ord = Number(v); });
  seg("fxLpOrd", v => { fx.cfg.lp.ord = Number(v); });
  seg("fxCpOn", v => { fx.cfg.comp.on = v === "on"; });
  seg("fxLmOn", v => { fx.cfg.lim.on = v === "on"; });
  seg("fxBandOn", v => { const b = band(); if (b) b.on = v === "on"; });
  $("fxMatch").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; fx.match = b.dataset.v === "on"; fxSave(); fxRender(); if (fx.listen !== "off") fxSend(); });
  const slider = (id, set) => {
    const el = $(id);
    el.addEventListener("input", () => { set(Number(el.value)); fxChanged(); });
    el.addEventListener("change", () => el.blur());
  };
  slider("fxThr", v => { fx.cfg.comp.thr = v; });
  slider("fxRatio", v => { fx.cfg.comp.ratio = v; });
  slider("fxKnee", v => { fx.cfg.comp.knee = v; });
  slider("fxAtt", v => { fx.cfg.comp.att = v; });
  slider("fxRel", v => { fx.cfg.comp.rel = v; });
  slider("fxMakeup", v => { fx.cfg.comp.makeup = v; });
  slider("fxCeil", v => { fx.cfg.lim.ceil = v; });
  slider("fxLmRel", v => { fx.cfg.lim.rel = v; });
  slider("fxLook", v => { fx.cfg.lim.look = v; });
  slider("fxOut", v => { fx.cfg.out = v; });
  slider("fxMdRate", v => { fx.cfg.mod.rate = v; });
  slider("fxMdDepth", v => { fx.cfg.mod.depth = v / 100; });
  slider("fxMdFb", v => { fx.cfg.mod.fb = v / 100; });
  slider("fxMdMix", v => { fx.cfg.mod.mix = v / 100; });
  slider("fxDlFb", v => { fx.cfg.delay.fb = v / 100; });
  slider("fxDlMix", v => { fx.cfg.delay.mix = v / 100; });
  slider("fxRvDecay", v => { fx.cfg.rev.decay = v; });
  slider("fxRvDamp", v => { fx.cfg.rev.damp = v / 100; });
  slider("fxRvPre", v => { fx.cfg.rev.pre = v; });
  slider("fxRvCut", v => { fx.cfg.rev.cut = v; });
  slider("fxRvMix", v => { fx.cfg.rev.mix = v / 100; });
  slider("fxGtDepth", v => { fx.cfg.gate.depth = v / 100; });
  slider("fxDsF", v => { fx.cfg.ds.f = v; });
  slider("fxDsThr", v => { fx.cfg.ds.thr = v; });
  slider("fxDsRange", v => { fx.cfg.ds.range = v; });
  seg("fxDsOn", v => { fx.cfg.ds.on = v === "on"; });
  seg("fxMdMode", v => { fx.cfg.mod.mode = v; });
  seg("fxDlOn", v => { fx.cfg.delay.on = v === "on"; });
  seg("fxDlPp", v => { fx.cfg.delay.pp = v === "on"; });
  seg("fxRvOn", v => { fx.cfg.rev.on = v === "on"; });
  seg("fxGtOn", v => { fx.cfg.gate.on = v === "on"; });
  seg("fxGtShape", v => { fx.cfg.gate.square = v === "square"; });
  num("fxBpm", () => true, v => { fx.cfg.bpm = v; }, 40, 240);
  num("fxDlMs", () => true, v => { fx.cfg.delay.ms = v; }, 1, 2000);
  num("fxGtRate", () => true, v => { fx.cfg.gate.rate = v; }, 0.05, 40);
  fxDd($("fxDlNote"), FX_NOTES, v => { fx.cfg.delay.note = v; fxChanged(); });
  fxDd($("fxGtNote"), FX_NOTES, v => { fx.cfg.gate.note = v; fxChanged(); });
  $("fxBandChips").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; if (b.dataset.i === "add") fxBandAdd(1000, 0); else { fx.band = Number(b.dataset.i); fxRender(); } });
  $("fxBandDel").addEventListener("click", fxBandDel);
  $("fxListen").addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; fxListen(b.dataset.v); });
  $("fxSave").addEventListener("click", fxPresetSave);
  $("fxDel").addEventListener("click", fxPresetDel);
  $("fxApply").addEventListener("click", fxApply);
  $("fxByp").addEventListener("click", e => { const b = e.target.closest("button"); const h = fxSesHolder(); if (!b || !h) return; h.fx = { on: b.dataset.v === "on", cfg: fxClone(fx.cfg) }; fxSesPush(true); fxRender(); });
  $("fxRemove").addEventListener("click", () => { const h = fxSesHolder(); if (!h) return; h.fx = null; fx.cfg = fxMake({}); fx.preset = "flat"; fx.band = 0; fxSesPush(true); fxRender(); });
  $("fxCancel").addEventListener("click", () => ed.worker.postMessage({ t: "fxcancel" }));
  $("fxDefaults").addEventListener("click", () => { fx.cfg = fxMake({}); fx.preset = "flat"; fx.band = 0; fxChanged(true); });
  window.addEventListener("resize", () => { if (fx.target) fxSesPlace(); if (rp.open && rp.tab === "fx") fxDraw(); });
  document.addEventListener("i18n", () => { fxPresetsUi(); fxDd($("fxType"), FX_TYPES, fxTypePick); fxDd($("fxDlNote"), FX_NOTES, v => { fx.cfg.delay.note = v; fxChanged(); }); fxDd($("fxGtNote"), FX_NOTES, v => { fx.cfg.gate.note = v; fxChanged(); }); if (rp.open && rp.tab === "fx") fxRender(); });
}

function dgRow() { return 26 * thFs(); }
const DG_LENS = [1, 2, 5, 10, 20];
const rp = { open: false, tab: "diag", selKey: "" };
const DG_FX = [{ v: "click", label: "DeClicker" }, { v: "clip", label: "DeClipper" }];
const DG_MINS = [1, 2, 3, 5, 8];
const dg = { open: false, res: null, sel: new Set(), focus: -1, scan: null, listen: "off", cfg: null, seq: 0, refresh: 0, done: 0 };

function dgLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem("studioDeclick") || "null"); } catch {}
  dg.cfg = Object.assign({ sens: 50, maxMs: 5, link: true, kind: "click", tol: 1, minRun: 2 }, v && typeof v === "object" ? v : {});
  if (!DG_FX.some(f => f.v === dg.cfg.kind)) dg.cfg.kind = "click";
}

function dgSave() {
  try { localStorage.setItem("studioDeclick", JSON.stringify(dg.cfg)); } catch {}
}

function dgRange() {
  const f = dg.res && dg.focus >= 0 ? dg.res.events[dg.focus] : null;
  if (f && ed.sel.a === f.a && ed.sel.b === f.b) return { a: dg.res.a, b: dg.res.b, sel: dg.res.b - dg.res.a < ed.doc.frames };
  if (selOn()) return { a: ed.sel.a, b: ed.sel.b, sel: true };
  return { a: 0, b: ed.doc ? ed.doc.frames : 0, sel: false };
}

function openRepair(tab) {
  if (!ed.doc) return;
  if (fx.target) fxSesClose();
  closePopovers();
  const prev = rp.open ? rp.tab : null;
  rp.open = true;
  rp.tab = ["nr", "hum", "ld", "fx", "md", "tr", "tx", "rv"].includes(tab) ? tab : "diag";
  if (rp.tab !== "ld" && rp.tab !== "fx" && rp.tab !== "md" && rp.tab !== "tr" && rp.tab !== "tx" && rp.tab !== "rv") rp.last = rp.tab;
  dg.open = rp.tab === "diag";
  $("diag").classList.remove("hidden");
  $("dgBody").classList.toggle("hidden", rp.tab !== "diag");
  $("nrBody").classList.toggle("hidden", rp.tab !== "nr");
  $("humBody").classList.toggle("hidden", rp.tab !== "hum");
  $("ldBody").classList.toggle("hidden", rp.tab !== "ld");
  $("fxBody").classList.toggle("hidden", rp.tab !== "fx");
  $("mdBody").classList.toggle("hidden", rp.tab !== "md");
  $("trBody").classList.toggle("hidden", rp.tab !== "tr");
  $("txBody").classList.toggle("hidden", rp.tab !== "tx");
  $("rvBody").classList.toggle("hidden", rp.tab !== "rv");
  document.querySelectorAll("#rpTabs button").forEach(b => b.classList.toggle("on", b.dataset.v === rp.tab));
  const onTab = document.querySelector("#rpTabs button.on");
  if (onTab) onTab.scrollIntoView({ block: "nearest", inline: "nearest" });
  if (prev === "diag" && rp.tab !== "diag") dgListen("off");
  if (prev === "nr" && rp.tab !== "nr") nrHide();
  if (prev === "hum" && rp.tab !== "hum") humHide();
  if (prev === "ld" && rp.tab !== "ld") ldHide();
  if (prev === "fx" && rp.tab !== "fx") fxHide();
  if (prev === "md" && rp.tab !== "md") mdHide();
  if (prev === "tr" && rp.tab !== "tr") trHide();
  if (prev === "tx" && rp.tab !== "tx") txHide();
  if (prev === "rv" && rp.tab !== "rv") rvHide();
  if (rp.tab === "diag") dgRender();
  else if (rp.tab === "nr" && prev !== "nr") nrShow();
  else if (rp.tab === "hum" && prev !== "hum") humShow();
  else if (rp.tab === "ld" && prev !== "ld") ldShow();
  else if (rp.tab === "fx" && prev !== "fx") fxShow();
  else if (rp.tab === "md" && prev !== "md") mdShow();
  else if (rp.tab === "tr" && prev !== "tr") trShow();
  else if (rp.tab === "tx" && prev !== "tx") txShow();
  else if (rp.tab === "rv" && prev !== "rv") rvShow();
  redraw();
}

function openDiag(kind) {
  if (kind && kind !== dg.cfg.kind) { dg.cfg.kind = kind; dgSave(); dgReset(); }
  openRepair("diag");
}

function closeDiag() {
  if (fx.target) { fxSesClose(); return; }
  const was = rp.open ? rp.tab : null;
  rp.open = false;
  dg.open = false;
  $("diag").classList.add("hidden");
  dgListen("off");
  if (was === "nr") nrHide();
  if (was === "hum") humHide();
  if (was === "ld") ldHide();
  if (was === "fx") fxHide();
  if (was === "md") mdHide();
  if (was === "tr") trHide();
  redraw();
}

function toggleDiag(kind) { if (rp.open && rp.tab === "diag" && (!kind || kind === dg.cfg.kind)) closeDiag(); else openDiag(kind); }
function toggleNr() { if (rp.open && rp.tab === "nr") closeDiag(); else openRepair("nr"); }
function toggleRepair() { const other = rp.tab === "ld" || rp.tab === "fx" || rp.tab === "md" || rp.tab === "tr" || rp.tab === "tx" || rp.tab === "rv"; if (rp.open && !other) closeDiag(); else openRepair(other ? rp.last || "diag" : rp.tab); }
function toggleHum() { if (rp.open && rp.tab === "hum") closeDiag(); else openRepair("hum"); }

function rpTick() {
  if (!rp.open) return;
  const key = ed.sel.a + ":" + ed.sel.b;
  if (key === rp.selKey) return;
  rp.selKey = key;
  if (rp.tab === "nr") nrRender(); else if (rp.tab === "hum") humRender(); else if (rp.tab === "ld") { ldRender(); ldAuto(); } else if (rp.tab === "fx") fxRender(); else if (rp.tab === "md") mdRender(); else if (rp.tab === "tr") trRender(); else if (rp.tab === "tx") txRender(); else if (rp.tab === "rv") rvRender(); else dgRender();
}

function dgListen(mode) {
  dg.listen = mode;
  ed.worker.postMessage({ t: "dlisten", mode });
  document.querySelectorAll("#dgListen button").forEach(b => b.classList.toggle("on", b.dataset.v === mode));
}

function dgReset() {
  if (dg.scan) ed.worker.postMessage({ t: "dcancel" });
  dg.scan = null;
  dg.res = null;
  dg.done = 0;
  dg.sel.clear();
  dg.focus = -1;
  ed.worker.postMessage({ t: "dclear" });
  dgListen("off");
  if (dg.open) dgRender();
}

function dgApply(res) {
  dg.res = res;
  dg.sel = new Set([...dg.sel].filter(i => res && i < res.events.length));
  if (!res || dg.focus >= res.events.length) dg.focus = -1;
  if (dg.open) dgRender();
  redraw();
}

function dgChanText(det) {
  if (det.length === 2) return det[0] && det[1] ? "L R" : det[0] ? "L" : "R";
  return det.map((v, i) => v ? i + 1 : null).filter(Boolean).join(" ");
}

function dgPeakDb(v) { return (v > 0 ? "+" : "") + v.toFixed(1) + " dBFS"; }

function dgRender() {
  const c = dg.cfg, r = dgRange(), clip = c.kind === "clip";
  const fx = $("dgFx");
  if (!fx.dataset.ready) {
    fx.dataset.ready = "1";
    fx.innerHTML = `<div class="cur"></div><div class="list"></div>`;
    ddInit(fx, DG_FX, c.kind, v => { if (v !== dg.cfg.kind) { dg.cfg.kind = v; dgSave(); dgReset(); } dgRender(); });
  }
  const it = DG_FX.find(f => f.v === c.kind);
  fx.querySelector(".cur").textContent = t(it.label);
  fx.dataset.v = c.kind;
  document.querySelectorAll("#dgBody .dgclick").forEach(el => el.classList.toggle("hidden", clip));
  document.querySelectorAll("#dgBody .dgclip").forEach(el => el.classList.toggle("hidden", !clip));
  $("dgTol").value = c.tol;
  $("dgTolV").textContent = Number(c.tol).toFixed(1) + " %";
  document.querySelectorAll("#dgMin button").forEach(b => b.classList.toggle("on", Number(b.dataset.v) === c.minRun));
  $("dgSens").value = c.sens;
  $("dgSensV").textContent = c.sens;
  document.querySelectorAll("#dgLen button").forEach(b => b.classList.toggle("on", Number(b.dataset.v) === c.maxMs));
  document.querySelectorAll("#dgLink button").forEach(b => { b.classList.toggle("on", (b.dataset.v === "link") === c.link); b.disabled = ed.doc && ed.doc.channels === 1; });
  $("dgRange").textContent = (r.sel ? t("Selection") : t("Whole file")) + " · " + fmtTime(r.a) + "–" + fmtTime(r.b);
  const busy = !!dg.scan;
  $("dgScan").disabled = busy || !ed.doc || r.b <= r.a;
  $("dgScan").textContent = t(dg.res ? "Scan again" : "Scan");
  $("dgCancel").classList.toggle("hidden", !busy);
  $("dgBar").classList.toggle("hidden", !busy);
  const res = dg.res, n = res ? res.events.length : 0;
  let sum = "";
  if (busy) sum = t("Scanning…");
  else if (res && res.kind === "clip") {
    if (n === 0) sum = dg.done ? t("All found clipping is repaired.") : res.verdict === false ? t("No clipping found. The loudest peaks look natural.") : t("No clipping found.");
    else {
      sum = n + " " + t(n === 1 ? "clipped span found" : "clipped spans found");
      const lv = res.levels ? Math.max(...res.levels.top, ...res.levels.bot) : null;
      if (lv !== null) sum += " · " + t("clip level") + " " + dgPeakDb(lv);
      if (res.peak > 0) sum += ". " + t("Repaired peaks reach {p}. Lower the level on export so they don't clip again.").replace("{p}", dgPeakDb(res.peak));
      const long = res.events.filter(e => e.long).length;
      if (long) sum += " · " + long + " " + t("too long to rebuild");
    }
    if (res.capped) sum += " · " + t("stopped at the first 50,000; raise the minimum clip size");
    if (res.stale) sum += " · " + res.stale + " " + t("changed since the scan");
  } else if (res) {
    sum = n === 0 ? (dg.done ? t("All found clicks are repaired.") : t("No clicks found.")) : n + " " + t(n === 1 ? "click found" : "clicks found");
    if (res.capped) sum += " · " + t("stopped at the first 50,000; lower the sensitivity");
    if (res.stale) sum += " · " + res.stale + " " + t("changed since the scan");
  } else sum = clip ? t("Scan finds flat-topped peaks where the recording ran out of headroom and rebuilds their shape.") : t("Scan finds clicks and crackle. Listen to what would be removed before you repair.");
  $("dgSum").textContent = sum;
  const usable = res ? res.events.filter(e => e.ok).length : 0;
  $("dgAll").disabled = busy || !usable;
  $("dgRepair").disabled = busy || ![...dg.sel].some(i => res && res.events[i] && res.events[i].ok);
  $("dgRepair").textContent = dg.sel.size > 1 ? t("Repair") + " " + dg.sel.size : t("Repair");
  $("dgClear").disabled = busy || !res;
  document.querySelectorAll("#dgListen button").forEach(b => { b.disabled = !usable && b.dataset.v !== "off"; b.classList.toggle("on", b.dataset.v === dg.listen); });
  dgList();
}

function dgList() {
  const box = $("dgList"), res = dg.res, n = res ? res.events.length : 0;
  let inner = box.firstElementChild;
  if (!inner) { inner = document.createElement("div"); inner.className = "dgin"; box.appendChild(inner); }
  inner.style.height = n * dgRow() + "px";
  box.classList.toggle("hidden", !n);
  const top = box.scrollTop, h = box.clientHeight || 240;
  const i0 = Math.max(0, Math.floor(top / dgRow()) - 4), i1 = Math.min(n, Math.ceil((top + h) / dgRow()) + 4);
  inner.textContent = "";
  for (let i = i0; i < i1; i++) {
    const e = res.events[i];
    const row = document.createElement("div");
    row.className = "dgrow" + (dg.sel.has(i) ? " sel" : "") + (i === dg.focus ? " focus" : "") + (e.ok ? "" : " stale");
    row.style.top = i * dgRow() + "px";
    row.dataset.i = i;
    const ms = (e.b - e.a) * 1000 / ed.doc.sampleRate;
    row.innerHTML = `<span class="dgn"></span><span class="dgt"></span><span class="dgl"></span><span class="dgc"></span><span class="dgs"></span>`;
    row.querySelector(".dgn").textContent = i + 1;
    row.querySelector(".dgt").textContent = fmtTime(e.a);
    row.querySelector(".dgl").textContent = (ms < 1 ? ms.toFixed(2) : ms.toFixed(1)) + " ms";
    row.querySelector(".dgc").textContent = dgChanText(e.det);
    row.querySelector(".dgs").textContent = !e.ok ? (e.long ? t("too long") : t("changed")) : res.kind === "clip" ? (e.s >= 0 ? "+" : "") + e.s.toFixed(1) : Math.round(e.s);
    inner.appendChild(row);
  }
}

function dgFocus(i, add) {
  const res = dg.res;
  if (!res || i < 0 || i >= res.events.length) return;
  const e = res.events[i];
  if (add) { if (dg.sel.has(i)) dg.sel.delete(i); else dg.sel.add(i); }
  else dg.sel = new Set([i]);
  dg.focus = i;
  const sr = ed.doc.sampleRate, pad = Math.round(sr * 0.012), span = (e.b - e.a) + 2 * pad;
  ed.view.spp = Math.max(1 / 16, span / viewWidth());
  ed.view.start = Math.round((e.a + e.b) / 2 - viewWidth() * ed.view.spp / 2);
  clampView();
  ed.sel = { a: e.a, b: e.b };
  ed.cursor = e.a;
  const box = $("dgList");
  if (i * dgRow() < box.scrollTop) box.scrollTop = i * dgRow();
  else if ((i + 1) * dgRow() > box.scrollTop + box.clientHeight) box.scrollTop = (i + 1) * dgRow() - box.clientHeight;
  dgRender();
  redraw();
}

function dgProg(m) {
  if (!dg.scan || m.id !== dg.scan.id) return;
  $("dgBar").querySelector("i").style.width = Math.round(m.frac * 100) + "%";
}

async function dgScan() {
  if (!ed.doc || dg.scan) return;
  const r = dgRange();
  if (r.b <= r.a) return;
  const id = "s" + (++dg.seq);
  dg.scan = { id };
  dg.done = 0;
  dg.sel.clear();
  dg.focus = -1;
  dgListen("off");
  $("dgBar").querySelector("i").style.width = "0%";
  dgRender();
  try {
    const res = await call({ t: "dscan", id: ed.doc.id, jobId: id, a: r.a, b: r.b, kind: dg.cfg.kind, sens: dg.cfg.sens, maxMs: dg.cfg.maxMs, link: dg.cfg.link, tol: dg.cfg.tol, minRun: dg.cfg.minRun });
    if (dg.scan && dg.scan.id === id) { dg.scan = null; dgApply(res.diag); }
  } catch (e) {
    const mine = dg.scan && dg.scan.id === id;
    if (mine) dg.scan = null;
    if (mine && e.message !== "cancelled" && e.message !== "stale") tell(String(e.message || e), t("Scan failed"));
    if (dg.open) dgRender();
  }
}

async function dgRepair(all) {
  if (!ed.doc || !dg.res) return;
  const idx = all ? null : [...dg.sel].sort((x, y) => x - y);
  if (idx && !idx.length) return;
  const r = await runEdit({ t: "drepair", idx }, false, true);
  if (r && r.diag !== undefined) {
    dg.done += r.hist[r.idx].n || 0;
    dg.sel.clear();
    dg.focus = -1;
    dgApply(r.diag);
    const n = r.hist[r.idx].n || 0;
    if (r.hist[r.idx].op === "declip") flash(n === 1 ? t("Repaired 1 clipped span") : t("Repaired {n} clipped spans").replace("{n}", n));
    else flash(n === 1 ? t("Repaired 1 click") : t("Repaired {n} clicks").replace("{n}", n));
  }
}

function dgAfterEdit() {
  if (!dg.res || dg.scan) return;
  clearTimeout(dg.refresh);
  dg.refresh = setTimeout(async () => {
    try { const r = await call({ t: "dstate" }); if (!dg.scan) dgApply(r.diag); } catch {}
  }, 120);
}

function drawDiag(g, W, H, dpr) {
  if (rp.open && rp.tab === "nr") { drawNrPrint(g, W, H, dpr); return; }
  if (rp.open && rp.tab === "hum") return;
  if (rp.open && rp.tab === "tr") { drawTr(g, W, H, dpr); return; }
  if (!dg.open || !dg.res || !dg.res.events.length) return;
  const ev = dg.res.events, v0 = ed.view.start, v1 = v0 + viewWidth() * ed.view.spp;
  let lo = 0, hi = ev.length - 1, i = ev.length;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (ev[m].b >= v0) { i = m; hi = m - 1; } else lo = m + 1; }
  const bar = Math.round(5 * dpr);
  for (let j = i; j < ev.length && ev[j].a <= v1; j++) {
    const e = ev[j];
    const x0 = Math.floor(xOf(e.a) * dpr), x1 = Math.max(x0 + Math.max(1, Math.round(dpr)), Math.ceil(xOf(e.b) * dpr));
    const on = j === dg.focus || dg.sel.has(j);
    g.fillStyle = !e.ok ? tc("grey", 0.7) : on ? TH.rred : tc("gred", 0.85);
    g.fillRect(x0, 0, x1 - x0, bar);
    if (on || x1 - x0 > 6 * dpr) { g.fillStyle = on ? tc("rred", 0.18) : tc("gred", 0.08); g.fillRect(x0, bar, x1 - x0, H - bar); }
  }
}

function wireDiag() {
  dgLoad();
  $("dgX").addEventListener("click", closeDiag);
  $("rpTabs").addEventListener("click", e => { const b = e.target.closest("button"); if (b) openRepair(b.dataset.v); });
  $("dgSens").addEventListener("input", () => { dg.cfg.sens = Number($("dgSens").value); $("dgSensV").textContent = dg.cfg.sens; dgSave(); });
  $("dgSens").addEventListener("change", () => $("dgSens").blur());
  const seg = (id, fn) => $(id).addEventListener("click", e => { const b = e.target.closest("button"); if (!b || b.disabled) return; fn(b.dataset.v); dgSave(); dgRender(); });
  seg("dgLen", v => { dg.cfg.maxMs = Number(v); });
  seg("dgMin", v => { dg.cfg.minRun = Number(v); });
  $("dgTol").addEventListener("input", () => { dg.cfg.tol = Number($("dgTol").value); $("dgTolV").textContent = dg.cfg.tol.toFixed(1) + " %"; dgSave(); });
  $("dgTol").addEventListener("change", () => $("dgTol").blur());
  seg("dgLink", v => { dg.cfg.link = v === "link"; });
  seg("dgListen", v => dgListen(v));
  $("dgScan").addEventListener("click", dgScan);
  $("dgCancel").addEventListener("click", () => ed.worker.postMessage({ t: "dcancel" }));
  $("dgAll").addEventListener("click", () => dgRepair(true));
  $("dgRepair").addEventListener("click", () => dgRepair(false));
  $("dgClear").addEventListener("click", dgReset);
  $("dgList").addEventListener("scroll", dgList);
  $("dgList").addEventListener("click", e => { const row = e.target.closest(".dgrow"); if (row) { dgFocus(Number(row.dataset.i), e.shiftKey || e.ctrlKey || e.metaKey); $("dgList").focus({ preventScroll: true }); } });
  $("diag").addEventListener("keydown", e => {
    if (e.key === "Escape" && !e.target.closest(".dd.open")) { e.stopPropagation(); closeDiag(); return; }
    if (rp.tab !== "diag" || !dg.res || !dg.res.events.length || e.target.closest("input")) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") { e.preventDefault(); e.stopPropagation(); dgFocus(Math.max(0, Math.min(dg.res.events.length - 1, dg.focus + (e.key === "ArrowDown" ? 1 : -1))), false); }
    else if (e.key === "Enter" && dg.focus >= 0 && e.target.closest("#dgList")) { e.preventDefault(); e.stopPropagation(); dgRepair(false); }
  });
  document.addEventListener("i18n", () => { if (dg.open) dgRender(); });
}

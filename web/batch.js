const BT_KINDS = [
  { v: "fx", label: "Effects preset" },
  { v: "loud", label: "Match loudness" },
  { v: "norm", label: "Normalize" },
  { v: "dc", label: "Remove DC offset" },
  { v: "mono", label: "Mix to mono" },
  { v: "stretch", label: "Stretch and pitch" }
];
const BT_FMTS = [
  { v: "wav24", label: "WAV 24-bit", fmt: { type: "wav", bits: 24 } },
  { v: "wav16", label: "WAV 16-bit", fmt: { type: "wav", bits: 16 } },
  { v: "wav32", label: "WAV 32-bit float", fmt: { type: "wav", bits: 32 } },
  { v: "flac24", label: "FLAC 24-bit", fmt: { type: "flac", bits: 24 } },
  { v: "flac16", label: "FLAC 16-bit", fmt: { type: "flac", bits: 16 } }
];
const BT_RATES = [{ v: "0", label: "Same as the file" }, { v: "44100", label: "44.1 kHz" }, { v: "48000", label: "48 kHz" }, { v: "96000", label: "96 kHz" }];
const BT_OUT = { fmt: "wav24", rate: 0, dest: "locker", folder: "Studio/Batch", tpl: "$name" };
const BT_START = [
  { name: "Podcast voice, −16 LUFS", steps: [{ kind: "fx", preset: "mic" }, { kind: "fx", preset: "deess" }, { kind: "loud", target: -16, ceil: -1 }], out: { fmt: "wav24", rate: 48000, dest: "locker", folder: "Studio/Podcast", tpl: "$name" } },
  { name: "Vinyl rip clean-up", steps: [{ kind: "dc" }, { kind: "fx", preset: "rumble" }, { kind: "norm", peak: -1 }], out: { fmt: "flac24", rate: 0, dest: "locker", folder: "Studio/Vinyl", tpl: "$name" } },
  { name: "Club master, −9 LUFS", steps: [{ kind: "fx", preset: "glue" }, { kind: "loud", target: -9, ceil: -1 }], out: { fmt: "wav24", rate: 0, dest: "locker", folder: "Studio/Masters", tpl: "$name (master)" } }
];
const bt = { recipes: [], cur: 0, sel: new Set(), run: null, rows: [], open: false };

function btKey() { return "studioRecipes:" + (studio.me ? studio.me.username : ""); }

function btLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(btKey()) || "null"); } catch {}
  bt.recipes = Array.isArray(v) && v.length ? v.map(btClean) : BT_START.map(btClean);
  bt.cur = Math.min(bt.cur, bt.recipes.length - 1);
}

function btSave() {
  try { localStorage.setItem(btKey(), JSON.stringify(bt.recipes)); } catch {}
}

function btClean(r) {
  const o = r && typeof r === "object" ? r : {};
  const steps = (Array.isArray(o.steps) ? o.steps : []).filter(s => s && BT_KINDS.some(k => k.v === s.kind)).slice(0, 20).map(s => Object.assign({}, s));
  return { name: String(o.name || t("Recipe")).slice(0, 80), steps, out: Object.assign({}, BT_OUT, o.out || {}) };
}

function btRecipe() { return bt.recipes[bt.cur]; }

function btPresetCfg(v) {
  const f = FX_FACTORY.find(p => p.v === v);
  if (f) return fxMake(f.cfg);
  const u = /^u\d+$/.test(v) ? fx.user[Number(v.slice(1))] : null;
  return u ? fxMake(u.cfg) : null;
}

function btPresetLabel(s) {
  const f = FX_FACTORY.find(p => p.v === s.preset);
  return f ? t(f.label) : s.name || t("Custom");
}

function btStepText(s) {
  if (s.kind === "fx") return btPresetLabel(s);
  if (s.kind === "loud") return (s.target ?? -14) + " LUFS · " + t("ceiling") + " " + (s.ceil ?? -1) + " dBTP";
  if (s.kind === "norm") return (s.peak ?? -1) + " dBTP";
  if (s.kind === "stretch") return (s.speed ?? 100) + " % · " + ((s.semis ?? 0) > 0 ? "+" : "") + (s.semis ?? 0) + " " + t("semitones");
  return "";
}

function btToggle(force) {
  bt.open = typeof force === "boolean" ? force : !bt.open;
  $("batch").classList.toggle("hidden", !bt.open);
  if (bt.open) btRender();
  bwPoll(bt.open);
}

async function btDocs() {
  try { ed.docs = (await call({ t: "list" })).docs; } catch {}
  return ed.docs || [];
}

function btRender() {
  if (!bt.open) return;
  const r = btRecipe(), busy = !!bt.run;
  const items = bt.recipes.map((x, i) => ({ v: String(i), label: x.name }));
  fxDd($("bRecipe"), items, v => { bt.cur = Number(v); btRender(); });
  const cur = $("bRecipe").querySelector(".cur");
  cur.textContent = r ? r.name : "";
  $("bSteps").innerHTML = r && r.steps.length ? r.steps.map((s, i) => {
    const kind = BT_KINDS.find(k => k.v === s.kind);
    let ctl = "";
    if (s.kind === "fx") ctl = `<div class="dd down bpre" data-i="${i}"><div class="cur">${esc(btPresetLabel(s))}</div><div class="list"></div></div>`;
    if (s.kind === "loud") ctl = `<input class="nin fxsm" data-i="${i}" data-k="target" value="${s.target ?? -14}" inputmode="decimal" aria-label="LUFS"><span class="unit">LUFS</span><input class="nin fxsm" data-i="${i}" data-k="ceil" value="${s.ceil ?? -1}" inputmode="decimal" aria-label="dBTP"><span class="unit">dBTP</span>`;
    if (s.kind === "norm") ctl = `<input class="nin fxsm" data-i="${i}" data-k="peak" value="${s.peak ?? -1}" inputmode="decimal" aria-label="dBTP"><span class="unit">dBTP</span>`;
    if (s.kind === "stretch") ctl = `<input class="nin fxsm" data-i="${i}" data-k="speed" value="${s.speed ?? 100}" inputmode="decimal" aria-label="%"><span class="unit">%</span><input class="nin fxsm" data-i="${i}" data-k="semis" value="${s.semis ?? 0}" inputmode="decimal" aria-label="${esc(t("semitones"))}"><span class="unit">${esc(t("semitones"))}</span>`;
    return `<div class="bstep"><span class="bn">${i + 1}</span><b>${esc(t(kind.label))}</b>${ctl}<span class="grow"></span><button class="x" data-up="${i}" title="${esc(t("Move up"))}" ${i ? "" : "disabled"}>↑</button><button class="x" data-del="${i}" title="${esc(t("Remove the step"))}">×</button></div>`;
  }).join("") : `<div class="snote">${esc(t("Add the steps this recipe runs on every file, in order."))}</div>`;
  $("bSteps").querySelectorAll(".bpre").forEach(el => {
    const i = Number(el.dataset.i);
    fxDd(el, fxPresetItems(), v => { const s = r.steps[i]; s.preset = v; const u = /^u\d+$/.test(v) ? fx.user[Number(v.slice(1))] : null; s.cfg = u ? fxClone(u.cfg) : null; s.name = u ? u.name : ""; btSave(); btRender(); });
  });
  const o = r ? r.out : BT_OUT;
  $("bFmt").querySelector(".cur").textContent = t((BT_FMTS.find(f => f.v === o.fmt) || BT_FMTS[0]).label);
  $("bRate").querySelector(".cur").textContent = t((BT_RATES.find(f => Number(f.v) === Number(o.rate)) || BT_RATES[0]).label);
  document.querySelectorAll("#bDest button").forEach(b => b.classList.toggle("on", b.dataset.v === o.dest));
  if (document.activeElement !== $("bFolder")) $("bFolder").value = o.folder;
  if (document.activeElement !== $("bTpl")) $("bTpl").value = o.tpl;
  $("bFolderRow").classList.toggle("hidden", o.dest !== "locker");
  const docs = ed.docs || [];
  $("bFiles").innerHTML = docs.length ? docs.map(d => {
    const row = bt.rows.find(x => x.id === d.id);
    const st = row ? `<span class="bst ${row.state}">${esc(row.text)}</span>` : "";
    return `<label class="bfile"><input type="checkbox" data-id="${esc(d.id)}" ${bt.sel.has(d.id) ? "checked" : ""} ${busy ? "disabled" : ""}><span class="bfn">${esc(d.name)}</span>${st}</label>`;
  }).join("") : `<div class="snote">${esc(t("Open or import the files into Studio first; they show up here."))}</div>`;
  $("bCount").textContent = bt.sel.size ? t("{n} selected").replace("{n}", bt.sel.size) : "";
  bwRender();
  $("bGo").disabled = busy || !r || !r.steps.length || !bt.sel.size;
  $("bGo").textContent = busy ? t("Running…") : t("Run");
  $("bCancel").classList.toggle("hidden", !busy);
  ["bNew", "bRename", "bDel", "bAdd"].forEach(id => { const el = $(id); if (el) el.classList.toggle("off", busy); });
}

async function btOpen() {
  btLoad();
  await btDocs();
  btToggle(true);
}

async function btNew() {
  const name = String((await askText(t("New recipe"), t("Recipe"))) || "").trim();
  if (!name) return;
  bt.recipes.push(btClean({ name, steps: [] }));
  bt.cur = bt.recipes.length - 1;
  btSave();
  btRender();
}

async function btRename() {
  const r = btRecipe();
  if (!r) return;
  const name = String((await askText(t("Rename the recipe"), r.name)) || "").trim();
  if (!name) return;
  r.name = name.slice(0, 80);
  btSave();
  btRender();
}

async function btDel() {
  const r = btRecipe();
  if (!r || !(await ask(t("Delete the recipe?"), r.name, { ok: t("delete") }))) return;
  bt.recipes.splice(bt.cur, 1);
  if (!bt.recipes.length) bt.recipes = BT_START.map(btClean);
  bt.cur = 0;
  btSave();
  btRender();
}

function btAdd(kind) {
  const r = btRecipe();
  if (!r) return;
  const s = { kind };
  if (kind === "fx") s.preset = "glue";
  if (kind === "loud") { s.target = -14; s.ceil = -1; }
  if (kind === "norm") s.peak = -1;
  if (kind === "stretch") { s.speed = 100; s.semis = 0; }
  r.steps.push(s);
  btSave();
  btRender();
}

async function btEdit(msg) {
  while (ed.editing) await new Promise(r => setTimeout(r, 30));
  ed.editing = true;
  try {
    const r = await call(Object.assign({ id: ed.doc.id, a: 0, b: 0, cursor: 0, chans: new Array(ed.doc.channels).fill(true), xfade: ed.xfade, snap: false, have: ed.srcs.length }, msg));
    applyState(r);
    setSelFrom(r.sel);
    redraw();
    return r;
  } finally { ed.editing = false; }
}

async function btStep(s, n) {
  const F = ed.doc.frames, id = "b" + n + Date.now().toString(36);
  if (s.kind === "fx") {
    const cfg = s.cfg ? fxMake(s.cfg) : btPresetCfg(s.preset);
    if (!cfg) throw new Error(t("The effects preset is no longer there."));
    return btEdit({ t: "fxapply", kind: "rk", jobId: id, ra: 0, rb: F, cfg: Object.assign(cfg, { match: false }) });
  }
  if (s.kind === "loud" || s.kind === "norm") {
    const st = (await call({ t: "ldmeasure", id: ed.doc.id, a: 0, b: 0, jobId: id + "m" })).stats;
    if (s.kind === "norm") {
      const pk = ldMax(st.tp);
      if (pk === null) return null;
      return btEdit({ t: "fxapply", kind: "ld", op: "norm", jobId: id, ra: 0, rb: F, cfg: { gain: (s.peak ?? -1) - pk, gains: null, ceil: 0, look: 2, rel: 15, lim: false } });
    }
    if (st.integrated === null) return null;
    const cfg = { ceil: s.ceil ?? -1, rel: 15, look: 2 };
    const fit = await call({ t: "ldfit", id: ed.doc.id, a: 0, b: 0, lin: st.integrated, target: s.target ?? -14, cfg, jobId: id + "f" });
    return btEdit({ t: "fxapply", kind: "ld", op: "loud", jobId: id, ra: 0, rb: F, cfg: Object.assign({ gain: fit.gain, gains: null, lim: true }, cfg) });
  }
  if (s.kind === "mono" && ed.doc.channels !== 2) return null;
  if (s.kind === "dc" || s.kind === "mono") {
    try { return await btEdit({ t: "proc", op: s.kind, jobId: id }); }
    catch (e) { if (String(e.message) === "dc-none") return null; throw e; }
  }
  if (s.kind === "stretch") {
    if (Number(s.speed ?? 100) === 100 && !Number(s.semis || 0)) return null;
    return btEdit({ t: "proc", op: "stretch", jobId: id, ra: 0, rb: F, speed: Math.max(25, Math.min(400, Number(s.speed) || 100)) / 100, semis: Number(s.semis) || 0, cents: 0 });
  }
  return null;
}

function btName(tpl, d) {
  const base = String(tpl || "$name").replace(/\$name/g, d.name.replace(/\.[a-z0-9]{2,5}$/i, "")).replace(/\$date/g, new Date().toISOString().slice(0, 10));
  return xpClean(base) || "export";
}

async function btExport(r) {
  const o = r.out, f = (BT_FMTS.find(x => x.v === o.fmt) || BT_FMTS[0]).fmt, d = ed.doc;
  const fmt = Object.assign({ rate: Number(o.rate) || 0 }, f);
  const name = btName(o.tpl, d) + "." + fmt.type;
  const dest = o.dest === "locker" ? { kind: "locker", folder: o.folder || "Studio" } : { kind: "download" };
  const jobId = "x" + Date.now().toString(36) + (++xp.seq);
  const job = { id: jobId, name, fmt, dest, state: "queued", frac: 0, doc: d.name, fmtLabel: xpFmtLabel(fmt, d.sampleRate), len: d.frames / d.sampleRate, pos: "" };
  xp.jobs.push(job);
  const pic = fmt.type === "flac" ? await xpDocPic(d) : null;
  await call({ t: "export", id: d.id, jobId, a: 0, b: d.frames, name, fmt, master: { gain: 0, dither: fmt.bits === 32 ? "off" : "tpdf", shaping: "off" }, dest, tags: xpDocTags(d), pic, marks: [] });
  xpQueue();
  xpBadge();
  return job;
}

function btRow(id, state, text) {
  let row = bt.rows.find(x => x.id === id);
  if (!row) { row = { id }; bt.rows.push(row); }
  row.state = state;
  row.text = text;
  btRender();
}

async function btGo() {
  const r = btRecipe();
  if (!r || bt.run || !bt.sel.size) return;
  const ids = (ed.docs || []).filter(d => bt.sel.has(d.id)).map(d => d.id);
  const run = bt.run = { cancel: false, done: 0, failed: 0, jobs: [] };
  bt.rows = ids.map(id => ({ id, state: "wait", text: t("waiting") }));
  btRender();
  const back = ed.doc ? ed.doc.id : null;
  for (const id of ids) {
    if (run.cancel) { btRow(id, "wait", t("not run")); continue; }
    try {
      btRow(id, "work", t("opening"));
      if (!ed.doc || ed.doc.id !== id) await openDoc(id);
      if (!ed.doc || ed.doc.id !== id) throw new Error(t("Could not open the file"));
      const start = ed.histIdx;
      for (let i = 0; i < r.steps.length; i++) {
        if (run.cancel) throw new Error("cancelled");
        btRow(id, "work", (i + 1) + "/" + r.steps.length + " · " + t(BT_KINDS.find(k => k.v === r.steps[i].kind).label));
        await btStep(r.steps[i], i);
      }
      btRow(id, "work", t("exporting"));
      run.jobs.push(await btExport(r));
      if (ed.histIdx !== start) await btEdit({ t: "jump", idx: start });
      run.done++;
      btRow(id, "ok", t("queued for export"));
    } catch (e) {
      const m = String(e.message || e);
      run.failed++;
      btRow(id, "bad", m === "cancelled" ? t("cancelled") : m);
    }
  }
  bt.run = null;
  if (back && ed.doc && ed.doc.id !== back && (ed.docs || []).some(d => d.id === back)) await openDoc(back);
  btRender();
  flash(t("Batch: {n} files processed, the exports are in the queue").replace("{n}", run.done) + (run.failed ? " · " + t("{n} failed").replace("{n}", run.failed) : ""));
}

const bw = { v: null, timer: 0 };

async function bwFetch(method, path, body) {
  const r = await fetch("/api/studio/watch" + (path || ""), { method: method || "GET", cache: "no-store", headers: body ? { "Content-Type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || "watch " + r.status);
  return j;
}

async function bwLoad() {
  try { bw.v = await bwFetch(); } catch { if (!bw.v) bw.v = { on: false, err: true, watches: [], log: [] }; }
  bwRender();
}

function bwPoll(on) {
  clearInterval(bw.timer);
  bw.timer = on ? setInterval(bwLoad, 8000) : 0;
  if (on) bwLoad();
}

function bwErr(m) {
  return ({ "same-folder": t("The results need a Locker folder other than the one watched."), off: t("Watch folders are not set up on this server yet."), "too-many": t("You can watch at most 20 folders."), folder: t("Name the Locker folder to watch.") })[m] || m;
}

function bwSteps(r) {
  return r.steps.map(s => {
    if (s.kind !== "fx") return Object.assign({}, s);
    const cfg = s.cfg ? fxMake(s.cfg) : btPresetCfg(s.preset);
    if (!cfg) throw new Error(t("The effects preset is no longer there."));
    return { kind: "fx", preset: s.preset, name: btPresetLabel(s), cfg: Object.assign(cfg, { match: false }) };
  });
}

const BW_MSG = [["unsupported or damaged file", "unsupported or damaged file"], ["already in the Locker as ", "already in the Locker as {p}"], ["loudness ", "loudness {v}"], ["silent, loudness skipped", "silent, loudness skipped"], ["silent, normalize skipped", "silent, normalize skipped"], ["the Locker is full", "the Locker is full"], ["file too large", "the file is too large"], ["file too long", "the file is too long"], ["no audio", "no audio in the file"]];

function bwMsg(m) {
  return String(m || "").split(" · ").map(part => {
    const e = BW_MSG.find(x => part.startsWith(x[0]));
    if (!e) return part;
    const rest = part.slice(e[0].length);
    return t(e[1]).replace("{p}", rest).replace("{v}", rest);
  }).join(" · ");
}

function bwOutLabel(o) {
  const f = BT_FMTS.find(x => x.v === o.fmt) || BT_FMTS[0], r = BT_RATES.find(x => Number(x.v) === Number(o.rate));
  return t(f.label) + (Number(o.rate) && r ? " · " + t(r.label) : "");
}

function bwTime(s) {
  const d = new Date(s * 1000), today = new Date().toDateString() === d.toDateString();
  return today ? d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : d.toLocaleDateString([], { day: "numeric", month: "short" }) + " " + d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function bwRender() {
  if (!bt.open) return;
  const v = bw.v, on = !!(v && v.on);
  $("bWatchNew").classList.toggle("hidden", !on);
  $("bWatchNote").textContent = !v ? "" : v.err ? t("The server's watch folders cannot be reached right now.") : on ? t("Studio's server runs a recipe on every new file in a Locker folder, also while Studio is closed. It checks every minute.") : t("Watch folders are not set up on this server yet.");
  const ws = on ? v.watches : [];
  $("bWatchList").innerHTML = ws.map(w => {
    const st = w.busy ? t("working on {f}").replace("{f}", w.busy.split("/").pop()) : !w.on ? t("paused") : w.last ? t("checked {t}").replace("{t}", bwTime(w.last)) : t("waiting for the first check");
    const steps = (w.steps || []).map(s => s.kind === "fx" ? s.name || t("Effects preset") : t((BT_KINDS.find(k => k.v === s.kind) || { label: s.kind }).label)).join(" → ");
    return `<div class="bwrow${w.on ? "" : " paused"}" data-id="${esc(w.id)}"><div class="bwn"><b>${esc(w.name)}</b><span title="${esc(steps)}">${esc(w.folder)} → ${esc(w.out.folder)} · ${esc(bwOutLabel(w.out))}</span><span class="bst${w.busy ? " work" : ""}">${esc(st)} · ${esc(t("{n} done").replace("{n}", w.done))}</span></div><button class="outbtn" data-act="on">${esc(w.on ? t("pause") : t("resume"))}</button><button class="outbtn" data-act="run" ${w.on ? "" : "disabled"}>${esc(t("check now"))}</button><button class="x" data-act="del" title="${esc(t("Stop watching"))}" aria-label="${esc(t("Stop watching"))}">×</button></div>`;
  }).join("");
  const names = new Map(ws.map(w => [w.id, w.name]));
  $("bWatchLog").innerHTML = (on ? v.log : []).slice(0, 30).map(l => `<div class="bwl" title="${esc((names.get(l.watch) || "") + " · " + l.file + " · " + l.msg)}"><span class="bwt">${esc(bwTime(l.t))}</span><span class="bst ${l.ok ? "ok" : "bad"}">${esc(l.file.split("/").pop())}</span><span class="bwm">${esc(bwMsg(l.msg))}</span></div>`).join("");
}

async function bwNew() {
  const r = btRecipe();
  if (!r || !r.steps.length) { await tell(t("Add the steps this recipe runs on every file, in order.")); return; }
  let steps;
  try { steps = bwSteps(r); } catch (e) { await tell(e.message); return; }
  const out = { fmt: r.out.fmt, rate: Number(r.out.rate) || 0, folder: r.out.folder || "Studio/Batch", tpl: r.out.tpl || "$name" };
  const note = t("New files there go through “{r}” and land in the Locker folder {o} as {f}.").replace("{r}", r.name).replace("{o}", out.folder).replace("{f}", bwOutLabel(out));
  const v = await askForm(t("Watch a Locker folder"), `<label class="dfield"><span>${esc(t("Folder"))}</span><input name="folder" value="Incoming" spellcheck="false" autocomplete="off"></label><label class="sesdoc"><input type="checkbox" name="existing"><span>${esc(t("also the files already in it"))}</span></label><div class="dnote">${esc(note)}</div>`, { ok: t("watch"), setup: f => requestAnimationFrame(() => { const i = f.querySelector("input"); if (i) i.select(); }) });
  if (!v) return;
  const folder = String(v.folder || "").trim();
  if (!folder) return;
  try { bw.v = await bwFetch("POST", "", { name: r.name, folder, steps, out, existing: !!v.existing }); }
  catch (e) { await tell(bwErr(e.message)); }
  bwRender();
}

async function bwAct(id, act) {
  const w = bw.v && (bw.v.watches || []).find(x => x.id === id);
  if (!w) return;
  try {
    if (act === "on") bw.v = await bwFetch("PATCH", "/" + encodeURIComponent(id), { on: !w.on });
    if (act === "run") { bw.v = await bwFetch("POST", "/" + encodeURIComponent(id) + "/run"); flash(t("Checking {f} now").replace("{f}", w.folder)); }
    if (act === "del") {
      if (!(await ask(t("Stop watching the folder?"), w.folder + " → " + w.out.folder, { ok: t("stop") }))) return;
      bw.v = await bwFetch("DELETE", "/" + encodeURIComponent(id));
    }
  } catch (e) { await tell(bwErr(e.message)); }
  bwRender();
}

const MC_SKIP = new Set(["macroRec", "macroRun", "palette", "keys", "batch"]);
const mc = { rec: null, list: [] };

function mcKey() { return "studioMacros:" + (studio.me ? studio.me.username : ""); }

function mcLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem(mcKey()) || "null"); } catch {}
  mc.list = Array.isArray(v) ? v.filter(m => m && typeof m.name === "string" && Array.isArray(m.ids)) : [];
}

function mcSave() { try { localStorage.setItem(mcKey(), JSON.stringify(mc.list)); } catch {} }

function mcNote(c) {
  if (mc.rec && c && !MC_SKIP.has(c.id)) { mc.rec.push(c.id); flash(t("Recorded") + ": " + cmdLabel(c)); }
}

async function mcToggle() {
  if (!mc.rec) { mc.rec = []; document.body.classList.add("mcrec"); flash(t("Recording a macro: run commands, then choose Stop recording")); return; }
  const ids = mc.rec;
  mc.rec = null;
  document.body.classList.remove("mcrec");
  if (!ids.length) { flash(t("Nothing was recorded.")); return; }
  const name = String((await askText(t("Name the macro"), t("Macro") + " " + (mc.list.length + 1), { message: ids.map(id => cmdLabel(CMD[id])).join(" → ") })) || "").trim();
  if (!name) return;
  mc.list.push({ name: name.slice(0, 60), ids });
  mcSave();
  flash(t("Saved the macro") + " " + name);
}

async function mcRun(m) {
  for (const id of m.ids) {
    const c = CMD[id];
    if (!c || !cmdEnabled(c)) { flash(t("The macro stopped at") + ": " + (c ? cmdLabel(c) : id)); return; }
    const r = ses.open && c.ss ? c.ss() : c.run();
    if (r && typeof r.then === "function") await r;
    while (ed.editing) await new Promise(res => setTimeout(res, 30));
  }
  flash(t("Ran the macro") + " " + m.name);
}

async function mcDelete(m) {
  if (!(await ask(t("Delete the macro?"), m.name, { ok: t("delete") }))) return;
  mc.list = mc.list.filter(x => x !== m);
  mcSave();
}

function mcEntries(q) {
  const out = [];
  for (const m of mc.list) {
    const label = t("Macro") + " · " + m.name, sc = fuzzy(q, label + " macro " + m.ids.join(" "));
    if (sc) out.push({ kind: "macro", label, group: m.ids.length + " " + t("steps"), score: sc + 4, run: () => mcRun(m) });
    const dl = t("Delete the macro") + " · " + m.name, ds = q ? fuzzy(q, dl + " macro remove") : 0;
    if (ds) out.push({ kind: "macro", label: dl, group: t("Macros"), score: ds - 3, run: () => mcDelete(m) });
  }
  return out;
}

function wireBatch() {
  btLoad();
  mcLoad();
  $("bX").addEventListener("click", () => btToggle(false));
  winDrag($("batch"), "studioBatchPos");
  $("bNew").addEventListener("click", btNew);
  $("bRename").addEventListener("click", btRename);
  $("bDel").addEventListener("click", btDel);
  fxDd($("bAdd"), BT_KINDS, v => btAdd(v));
  fxDd($("bFmt"), BT_FMTS, v => { btRecipe().out.fmt = v; btSave(); btRender(); });
  fxDd($("bRate"), BT_RATES, v => { btRecipe().out.rate = Number(v); btSave(); btRender(); });
  $("bDest").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; btRecipe().out.dest = b.dataset.v; btSave(); btRender(); });
  $("bFolder").addEventListener("change", () => { btRecipe().out.folder = $("bFolder").value.trim() || "Studio"; btSave(); btRender(); });
  $("bTpl").addEventListener("change", () => { btRecipe().out.tpl = $("bTpl").value.trim() || "$name"; btSave(); btRender(); });
  ["bFolder", "bTpl"].forEach(id => $(id).addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $(id).blur(); } e.stopPropagation(); }));
  $("bSteps").addEventListener("click", e => {
    const up = e.target.closest("[data-up]"), del = e.target.closest("[data-del]"), r = btRecipe();
    if (up) { const i = Number(up.dataset.up); [r.steps[i - 1], r.steps[i]] = [r.steps[i], r.steps[i - 1]]; btSave(); btRender(); }
    if (del) { r.steps.splice(Number(del.dataset.del), 1); btSave(); btRender(); }
  });
  $("bSteps").addEventListener("change", e => {
    const el = e.target.closest("input[data-k]");
    if (!el) return;
    const v = Number(String(el.value).replace(",", ".").replace("−", "-"));
    if (Number.isFinite(v)) btRecipe().steps[Number(el.dataset.i)][el.dataset.k] = v;
    btSave();
    btRender();
  });
  $("bSteps").addEventListener("keydown", e => { if (e.target.matches("input")) { if (e.key === "Enter") { e.preventDefault(); e.target.blur(); } e.stopPropagation(); } });
  $("bFiles").addEventListener("change", e => { const c = e.target.closest("input[data-id]"); if (!c) return; if (c.checked) bt.sel.add(c.dataset.id); else bt.sel.delete(c.dataset.id); btRender(); });
  $("bAll").addEventListener("click", () => { const all = (ed.docs || []).every(d => bt.sel.has(d.id)); bt.sel = all ? new Set() : new Set((ed.docs || []).map(d => d.id)); btRender(); });
  $("bGo").addEventListener("click", btGo);
  $("bCancel").addEventListener("click", () => { if (bt.run) bt.run.cancel = true; });
  $("bWatchNew").addEventListener("click", bwNew);
  $("bWatchList").addEventListener("click", e => { const b = e.target.closest("[data-act]"), row = e.target.closest(".bwrow"); if (b && row) bwAct(row.dataset.id, b.dataset.act); });
  document.addEventListener("i18n", () => { if (bt.open) btRender(); });
}

const sn = { ev: new Map(), taps: [], built: "", capture: false, measuring: false, cue: null };

function snData() {
  if (!ses.s.scenes || typeof ses.s.scenes !== "object") ses.s.scenes = { tempo: 120, quant: "bar", rows: [] };
  const d = ses.s.scenes;
  if (!Array.isArray(d.rows)) d.rows = [];
  if (!Number.isFinite(d.tempo)) d.tempo = 120;
  if (!["bar", "beat", "off"].includes(d.quant)) d.quant = "bar";
  d.ab = !!d.ab;
  return d;
}

function snQ() {
  const d = snData(), beat = ssRate() * 60 / d.tempo;
  return d.quant === "bar" ? Math.round(beat * 4) : d.quant === "beat" ? Math.round(beat) : 0;
}

function snModeKey() { return "studioSesMode:" + ses.s.id; }

function snMode(m) {
  if (!ses.open) return;
  if (ses.play.on) ssStop();
  ses.mode = m === "scenes" ? "scenes" : "multi";
  try { localStorage.setItem(snModeKey(), ses.mode); } catch {}
  if (ses.mode === "scenes") snShow(); else snHide();
  vwRender();
}

function snRestoreMode() {
  let m = "multi";
  try { m = localStorage.getItem(snModeKey()) || "multi"; } catch {}
  ses.mode = m === "scenes" ? "scenes" : "multi";
  if (ses.mode === "scenes") snShow(); else snHide();
}

function snShow() {
  $("ses").classList.add("scmode");
  $("sesBody").classList.add("hidden");
  document.querySelector("#ses .sesrow").classList.add("hidden");
  $("scn").classList.remove("hidden");
  sn.built = "";
  snRender();
}

function snHide() {
  snCueStop();
  $("ses").classList.remove("scmode");
  $("scn").classList.add("hidden");
  $("sesBody").classList.remove("hidden");
  document.querySelector("#ses .sesrow").classList.remove("hidden");
  if (ses.open) { ssHeads(); ssDraw(); }
}

function snNewRow(name) { return { id: ssNewId(), name: name || t("Scene") + " " + (snData().rows.length + 1), slots: {} }; }

function snSlotOf(k) { return { id: ssNewId(), doc: k.doc, from: k.from, len: k.len, name: k.name || "", loop: true, gain: k.gain || 0 }; }

function snLenText(k) { return fmtDur(k.len / ssRate()); }

function snRender() {
  if (!ses.open || ses.mode !== "scenes") return;
  const d = snData();
  snBar(d);
  const key = JSON.stringify([d.rows, d.ab, ses.s.tracks.map(tr => [tr.id, tr.name, tr.mute, tr.solo, tr.gain]), ses.s.sr]);
  if (key === sn.built) { snTick(ses.play.on ? ssPlayhead() : 0); return; }
  sn.built = key;
  const g = $("scGrid"), T = ses.s.tracks;
  g.style.gridTemplateColumns = "calc(150px*var(--fs)) repeat(" + Math.max(1, T.length) + ", minmax(calc(130px*var(--fs)), 1fr))";
  const h = [`<div class="sch sccorner"><button type="button" class="scstopall" title="${esc(t("Stop all"))}">■ ${esc(t("Stop all"))}</button></div>`];
  T.forEach((tr, i) => {
    h.push(`<div class="sch" data-tr="${esc(tr.id)}"><div class="sch1"><i class="sdot" style="background:${tc(SS_COLORS[i % SS_COLORS.length])}"></i><span class="schn">${esc(tr.name)}</span><button type="button" class="stm${tr.mute ? " on" : ""}" title="${esc(t("Mute"))}">M</button><button type="button" class="sts${tr.solo ? " on" : ""}" title="${esc(t("Solo"))}">S</button><button type="button" class="scstop" title="${esc(t("Stop this track"))}">■</button><button type="button" class="scmore" title="${esc(t("Fill this column…"))}" aria-label="${esc(t("Fill this column…"))}">⋯</button></div><input type="range" class="scvol" min="-48" max="12" step="0.5" value="${Math.max(-48, tr.gain)}" title="${esc(t("Vol"))}"></div>`);
  });
  if (!T.length) h.push(`<div class="sch scnote">${esc(t("Add a track first: each track is a column."))}</div>`);
  d.rows.forEach((row, r) => {
    h.push(`<div class="scrow" data-row="${esc(row.id)}"><button type="button" class="scgo" title="${esc(t("Launch the scene"))}">▶</button><span class="scrn">${esc(row.name || t("Scene") + " " + (r + 1))}</span></div>`);
    T.forEach((tr, i) => {
      const k = row.slots[tr.id];
      if (!k) { h.push(`<button type="button" class="scs empty" data-row="${esc(row.id)}" data-tr="${esc(tr.id)}" title="${esc(t("Choose a file…"))}"></button>`); return; }
      h.push(`<button type="button" class="scs" data-row="${esc(row.id)}" data-tr="${esc(tr.id)}" data-slot="${esc(k.id)}" style="--c:${tc(SS_COLORS[i % SS_COLORS.length])}"><span class="scsn">${esc(k.name || t("Clip"))}</span><span class="scsi">${k.loop ? "⟳ " : "→ "}${esc(snLenText(k))}${d.ab && Number.isFinite(k.lufs) ? " · " + esc(k.lufs.toFixed(1)) + " LUFS" : ""}</span><i class="scp"></i></button>`);
    });
  });
  h.push(`<div class="scrow scadd"><button type="button" class="outbtn scnew">+ ${esc(t("Scene"))}</button></div>`);
  g.innerHTML = h.join("");
  snTick(ses.play.on ? ssPlayhead() : 0);
}

function snBar(d) {
  const b = $("scBar");
  if (!b.dataset.wired) {
    b.dataset.wired = "1";
    b.innerHTML = `<label class="sctempo"><span>${esc(t("Tempo"))}</span><input id="scTempo" inputmode="decimal" spellcheck="false" autocomplete="off"><b>BPM</b></label><button type="button" class="outbtn" id="scTap">${esc(t("tap"))}</button>${segHtml("q", [["bar", "Bar"], ["beat", "Beat"], ["off", "Off"]], d.quant).replace('class="seg dseg"', 'class="seg" id="scQuant"')}<span class="grow"></span><button type="button" class="outbtn" id="scAb" title="${esc(t("One slot at a time, at matched loudness, switching at the same point"))}">A/B</button><button type="button" class="outbtn" id="scCap" title="${esc(t("Write what you launch onto the multitrack at its cursor when you stop"))}">● ${esc(t("Capture"))}</button><div class="dd down" id="scCue" title="${esc(t("Alt+click a slot to hear it on this output"))}"><div class="cur"></div><div class="list"></div></div><button type="button" class="outbtn" id="scFill">${esc(t("Fill from the multitrack"))}</button>`;
    const ti = $("scTempo");
    ti.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); ti.blur(); } e.stopPropagation(); });
    ti.addEventListener("change", () => { const v = Number(String(ti.value).replace(",", ".")); if (Number.isFinite(v)) snSetTempo(v); else ti.value = snData().tempo; });
    $("scTap").addEventListener("click", e => { e.currentTarget.blur(); snTap(); });
    $("scQuant").addEventListener("click", e => { const x = e.target.closest("button"); if (!x) return; x.blur(); snData().quant = x.dataset.v; ssCommit(); snBar(snData()); });
    $("scFill").addEventListener("click", e => { e.currentTarget.blur(); snFill(); });
    $("scAb").addEventListener("click", e => { e.currentTarget.blur(); snAbToggle(); });
    $("scCap").addEventListener("click", e => { e.currentTarget.blur(); sn.capture = !sn.capture; snBar(snData()); });
    snCueDd();
  }
  $("scAb").classList.toggle("on", d.ab);
  $("scCap").classList.toggle("on", sn.capture);
  if (document.activeElement !== $("scTempo")) $("scTempo").value = String(Math.round(d.tempo * 10) / 10);
  $("scQuant").querySelectorAll("button").forEach(x => x.classList.toggle("on", x.dataset.v === d.quant));
}

function snSetTempo(v) {
  snData().tempo = Math.max(20, Math.min(300, Math.round(v * 10) / 10));
  ssCommit();
  snBar(snData());
}

function snTap() {
  const now = performance.now(), T = sn.taps;
  if (T.length && now - T[T.length - 1] > 2000) T.length = 0;
  T.push(now);
  if (T.length > 8) T.shift();
  if (T.length < 3) { flash(t("Tap") + " " + T.length); return; }
  const iv = (T[T.length - 1] - T[0]) / (T.length - 1);
  snData().tempo = Math.max(20, Math.min(300, Math.round(60000 / iv * 10) / 10));
  ssSaveSoon();
  snBar(snData());
  flash(t("Tempo") + " " + snData().tempo + " BPM");
}

function snState(tid, ph) {
  const L = sn.ev.get(tid) || [];
  let cur = null, next = null;
  for (const e of L) { if (e.at <= ph) cur = e; else if (!next) next = e; }
  return { cur, next };
}

function snFind(id) {
  for (const row of snData().rows) for (const [tid, k] of Object.entries(row.slots)) if (k.id === id) return { row, tid, k };
  return null;
}

function snTick(ph) {
  if (!ses.open || ses.mode !== "scenes") return;
  const g = $("scGrid"), on = ses.play.on, blink = Math.floor(performance.now() / 250) % 2 === 0;
  g.querySelectorAll(".scs[data-slot]").forEach(el => {
    const st = on ? snState(el.dataset.tr, ph) : { cur: null, next: null }, id = el.dataset.slot, f = snFind(id);
    let play = !!(st.cur && st.cur.k === id), frac = 0;
    if (play && f) {
      const q = ph - st.cur.at + (st.cur.off || 0);
      if (!f.k.loop && q >= f.k.len) play = false;
      frac = f.k.loop ? (q % f.k.len) / f.k.len : Math.min(1, q / f.k.len);
    }
    el.classList.toggle("play", play);
    el.classList.toggle("queued", !!(st.next && st.next.k === id) && blink);
    el.querySelector(".scp").style.width = play ? (frac * 100).toFixed(1) + "%" : "0";
  });
  g.querySelectorAll(".sch[data-tr] .scstop").forEach(el => {
    const st = on ? snState(el.closest(".sch").dataset.tr, ph) : { next: null };
    el.classList.toggle("queued", !!(st.next && st.next.k === null) && blink);
  });
}

async function snLaunch(items) {
  if (!ses.open || !items.length) return;
  if (!ses.s.sr) { flash(t("Add a file first: it sets the session's sample rate.")); return; }
  if (pc.rec || pc.busy) return;
  const ab = snData().ab && items.length === 1 && items[0].k;
  const wire = ab ? snAbItems(items[0]) : items.map(it => ({ tr: it.tr, k: it.k ? Object.assign({}, it.k) : null }));
  if (!ses.play.on) { await snPlay(wire); return; }
  ed.worker.postMessage({ t: "sclaunch", items: wire, q: ab ? 0 : snQ() });
}

function snAbTarget() {
  const L = [];
  for (const r of snData().rows) for (const k of Object.values(r.slots)) if (Number.isFinite(k.lufs)) L.push(k.lufs);
  return L.length ? Math.min(...L) : null;
}

function snAbItems(it) {
  const T = snAbTarget(), k = Object.assign({}, it.k), ph = ses.play.on ? ssPlayhead() : 0;
  if (T !== null && Number.isFinite(k.lufs)) k.gain = (k.gain || 0) + (T - k.lufs);
  let ref = null;
  if (ses.play.on) for (const [tid, L] of sn.ev) { const st = snState(tid, ph); if (st.cur && st.cur.k && (!ref || st.cur.at > ref.at)) ref = st.cur; }
  return ses.s.tracks.map(tr => tr.id === it.tr ? { tr: tr.id, k, cont: ref ? { at: ref.at, off: ref.off || 0 } : null } : { tr: tr.id, k: null });
}

async function snAbToggle() {
  const d = snData();
  if (d.ab) { d.ab = false; ssSaveSoon(); snRender(); return; }
  if (sn.measuring) return;
  const todo = [];
  for (const r of d.rows) for (const k of Object.values(r.slots)) if (!Number.isFinite(k.lufs)) todo.push(k);
  sn.measuring = true;
  try {
    for (let i = 0; i < todo.length; i++) {
      clearTimeout(ed.flashT);
      $("stMsg").textContent = t("Measuring loudness") + " · " + (i + 1) + "/" + todo.length;
      try { const r = await call({ t: "sclufs", doc: todo[i].doc, from: todo[i].from, len: todo[i].len }); todo[i].lufs = Number.isFinite(r.lufs) ? r.lufs : null; } catch {}
    }
  } finally { sn.measuring = false; $("stMsg").textContent = ""; }
  if (!ses.open) return;
  snData().ab = true;
  ssSaveSoon();
  sn.built = "";
  snRender();
  flash(t("A/B: one slot at a time, matched to {v} LUFS").replace("{v}", (snAbTarget() ?? 0).toFixed(1)));
}

async function snPlay(items) {
  const sr = ses.s.sr;
  await ensureAudioFor(sr, 2);
  const end = sr * 3600 * 4;
  sn.ev = new Map(items.map(it => [it.tr, [{ at: 0, k: it.k ? it.k.id : null }]]));
  Atomics.store(ed.ring.ctrl, 0, 0);
  ses.play = { on: true, start: 0, end, loop: false, off: 0, t0: performance.now() };
  ed.worker.postMessage({ t: "sesplay", start: 0, end, loop: false, off: 0, scenes: true, items });
  ssButtons();
  if (!ses.ticking) { ses.ticking = true; ssTick(); }
}

function snLaunched(m) {
  for (const it of m.items) {
    const L = (sn.ev.get(it.tr) || []).filter(e => e.at < it.at);
    L.push({ at: it.at, k: it.k, off: it.off || 0 });
    sn.ev.set(it.tr, L);
  }
}

function snStopped(pos) {
  if (sn.capture && pos !== undefined) snCapture(pos);
  sn.ev = new Map();
  snTick(0);
}

function snCapture(pos) {
  const base = Math.round(ses.cursor), add = [];
  for (const [tid, L] of sn.ev) {
    const tr = ses.s.tracks.find(x => x.id === tid);
    if (!tr) continue;
    const mine = [];
    L.forEach((e, i) => {
      const f = e.k && snFind(e.k), end = Math.min(pos, i + 1 < L.length ? L[i + 1].at : pos);
      if (!f || end <= e.at) return;
      const k = f.k, b0 = e.at - (e.off || 0) % k.len;
      const put = s0 => { const s = Math.max(s0, e.at), x = Math.min(s0 + k.len, end); if (x - s >= 1) mine.push({ id: ssNewId(), doc: k.doc, at: base + s, from: k.from + (s - s0), len: x - s, gain: k.gain || 0, fin: 0, fout: 0, name: k.name }); };
      if (!k.loop) put(b0);
      else for (let s0 = b0; s0 < end; s0 += k.len) put(s0);
    });
    if (!mine.length) continue;
    const a = Math.min(...mine.map(k => k.at)), b = Math.max(...mine.map(k => k.at + k.len));
    tr.clips = smHole(tr.clips, a, b).map(k => k.id.endsWith("~") ? Object.assign({}, k, { id: ssNewId() }) : k).concat(mine).sort((p, q) => p.at - q.at);
    add.push(...mine);
  }
  if (!add.length) return;
  ssCommit();
  flash(t("{n} clips captured into the multitrack at {t}").replace("{n}", add.length).replace("{t}", fmtTime(base)));
}

async function snCueDevs() {
  let L = [];
  try { L = (await navigator.mediaDevices.enumerateDevices()).filter(d => d.kind === "audiooutput" && d.deviceId !== "default" && d.deviceId !== "communications"); } catch {}
  return L.map((d, i) => ({ v: d.deviceId, label: d.label || t("Output") + " " + (i + 1) }));
}

async function snCueDd() {
  const el = $("scCue"), can = typeof AudioContext !== "undefined" && "setSinkId" in AudioContext.prototype;
  let cur = "";
  try { cur = localStorage.getItem("studioCueDev") || ""; } catch {}
  const devs = can ? await snCueDevs() : [];
  const items = [{ v: "", label: t("Cue on the main output") }].concat(devs.map(d => ({ v: d.v, label: t("Cue") + ": " + d.label })));
  fxDd(el, items, v => { try { localStorage.setItem("studioCueDev", v); } catch {} snCueStop(); snCueDd(); });
  const it = items.find(x => x.v === cur) || items[0];
  el.querySelector(".cur").textContent = it.label;
}

function snCueStop() {
  const C = sn.cue;
  sn.cue = null;
  if (C) { try { C.src.stop(); } catch {} try { C.ctx.close(); } catch {} }
  document.querySelectorAll("#scGrid .scs.cue").forEach(e => e.classList.remove("cue"));
}

async function snCue(k) {
  const was = sn.cue && sn.cue.id;
  snCueStop();
  if (was === k.id) return;
  let r;
  try { r = await call({ t: "scread", doc: k.doc, from: k.from, len: k.len }); } catch (e) { tell(String(e.message || e)); return; }
  if (!r.n) return;
  const ctx = new AudioContext({ sampleRate: r.sr, latencyHint: "interactive" });
  let dev = "";
  try { dev = localStorage.getItem("studioCueDev") || ""; } catch {}
  if (dev && ctx.setSinkId) { try { await ctx.setSinkId(dev); } catch { flash(t("That output is not available. Cueing on the main output.")); } }
  const buf = ctx.createBuffer(r.ch, r.n, r.sr);
  for (let c = 0; c < r.ch; c++) buf.copyToChannel(r.data.subarray(c * r.n, (c + 1) * r.n), c);
  const src = ctx.createBufferSource(), g = ctx.createGain();
  src.buffer = buf;
  src.loop = k.loop;
  g.gain.value = Math.pow(10, (k.gain || 0) / 20);
  src.connect(g).connect(ctx.destination);
  src.onended = () => { if (sn.cue && sn.cue.src === src) snCueStop(); };
  src.start();
  sn.cue = { ctx, src, id: k.id };
  const el = document.querySelector('#scGrid .scs[data-slot="' + CSS.escape(k.id) + '"]');
  if (el) el.classList.add("cue");
}

function snRowLaunch(rowId) {
  const row = snData().rows.find(r => r.id === rowId);
  if (!row) return;
  snLaunch(ses.s.tracks.map(tr => ({ tr: tr.id, k: row.slots[tr.id] || null })));
}

function snFill() {
  const d = snData(), T = ses.s.tracks, n = Math.max(0, ...T.map(tr => tr.clips.length));
  if (!n) { flash(t("The multitrack has no clips yet.")); return; }
  const rows = Array.from({ length: n }, () => { const r = snNewRow(); d.rows.push(r); return r; });
  rows.forEach((r, i) => { r.name = t("Scene") + " " + (d.rows.indexOf(r) + 1); });
  T.forEach(tr => tr.clips.slice().sort((a, b) => a.at - b.at).forEach((k, i) => { rows[i].slots[tr.id] = snSlotOf(k); }));
  ssCommit();
  snRender();
  flash(t("{n} scenes from the multitrack").replace("{n}", n));
}

function snPut(tid, slots) {
  const d = snData();
  let i = 0;
  d.rows.forEach((r, j) => { if (r.slots[tid]) i = j + 1; });
  for (const k of slots) {
    if (!d.rows[i]) d.rows.push(snNewRow());
    d.rows[i].slots[tid] = k;
    i++;
  }
  d.rows.forEach((r, j) => { if (!r.name) r.name = t("Scene") + " " + (j + 1); });
  ssCommit();
  snRender();
  flash(t("{n} slots filled").replace("{n}", slots.length));
}

function snSections(marks, len, sr) {
  const pts = [...new Set(marks.filter(m => m.kind !== "range").map(m => Math.round(m.a)))].filter(a => a >= 0 && a < len).sort((x, y) => x - y);
  const name = a => { const m = marks.find(x => x.kind !== "range" && Math.round(x.a) === a); return m && m.name ? m.name : t("Marker") + " " + (m ? m.n : ""); };
  const out = [];
  if (pts.length && pts[0] > sr) out.push({ a: 0, b: pts[0], name: t("Before the first marker") });
  pts.forEach((a, i) => { const b = i + 1 < pts.length ? pts[i + 1] : len; if (b - a >= sr * 0.05) out.push({ a, b, name: name(a) }); });
  for (const m of marks) if (m.kind === "range" && m.b > m.a) out.push({ a: Math.max(0, m.a), b: Math.min(len, m.b), name: m.name || t("Range") + " " + m.n });
  return out.sort((x, y) => x.a - y.a);
}

function snFillMarks(tid) {
  const tr = ses.s.tracks.find(x => x.id === tid);
  if (!tr) return;
  const sr = ssRate(), end = Math.max(0, ...tr.clips.map(k => k.at + k.len));
  const marks = (ses.s.marks || []).map((m, i) => ({ n: i + 1, name: m.name, kind: "point", a: m.at }));
  const slots = [];
  for (const s of snSections(marks, end, sr)) {
    const k = tr.clips.find(q => q.at <= s.a && s.a < q.at + q.len);
    if (!k) continue;
    const len = Math.min(s.b, k.at + k.len) - s.a;
    if (len < sr * 0.05) continue;
    slots.push({ id: ssNewId(), doc: k.doc, from: k.from + (s.a - k.at), len, name: s.name, loop: true, gain: k.gain || 0 });
  }
  if (!slots.length) { flash(t("No sections between the markers on this track.")); return; }
  snPut(tid, slots);
}

async function snPickDoc(title, filter) {
  let docs = [];
  try { docs = (await call({ t: "list" })).docs.filter(d => !d.recording && (!filter || filter(d))); } catch {}
  if (!docs.length) { tell(t("There are no files in Studio yet. Open or record one first.")); return null; }
  const rows = docs.slice(0, 200).map(d => `<button type="button" class="vwrow" data-v="${esc(d.id)}"><b>${esc(d.name)}</b><span>${esc(((d.sampleRate || 0) / 1000).toLocaleString() + " kHz · " + fmtDur((d.len || d.frames || 0) / (d.sampleRate || 48000)))}</span></button>`).join("");
  const setup = f => f.querySelectorAll(".vwrow").forEach(b => b.addEventListener("click", () => { f.querySelector("[name=pick]").value = b.dataset.v; document.querySelector("#dlg .dok").click(); }));
  const v = await askForm(title, `<input type="hidden" name="pick" value=""><div class="vwrows">${rows}</div>`, { ok: t("choose"), setup });
  return v && v.pick && ses.open ? v.pick : null;
}

async function snFillFile(tid) {
  const id = await snPickDoc(t("Fill from a file's markers"));
  if (!id) return;
  let src;
  try { src = (await call({ t: "sesdoc", id })).doc; } catch { return; }
  const marks = (src && src.marks) || [];
  if (!marks.length) { tell(t("This file has no markers. Add some with M in the waveform.")); return; }
  const p = await ssPrepDoc(id);
  if (!p || !ses.open || !ses.s.tracks.some(x => x.id === tid)) return;
  const f = p.meta.sampleRate / src.meta.sampleRate, sm = marks.map(m => Object.assign({}, m, { a: Math.round(m.a * f), b: Math.round((m.b || m.a) * f) }));
  const slots = snSections(sm, p.len, p.meta.sampleRate).map(s => ({ id: ssNewId(), doc: p.id, from: s.a, len: s.b - s.a, name: s.name, loop: true, gain: 0 }));
  if (!slots.length) { flash(t("No sections between the markers in this file.")); return; }
  snPut(tid, slots);
}

function snFillTakes(tid) {
  const tr = ses.s.tracks.find(x => x.id === tid);
  if (!tr || !(tr.takes || []).length) return;
  snPut(tid, tr.takes.map(k => ({ id: ssNewId(), doc: k.doc, from: k.from || 0, len: k.len, name: k.name || t("Take") + " " + k.n, loop: true, gain: 0 })));
}

async function snFillStems(rowId) {
  let docs = [];
  try { docs = (await call({ t: "list" })).docs.filter(d => d.source && d.source.kind === "stem"); } catch {}
  const sets = new Map();
  for (const d of docs) { const k = String(d.source.id); if (!sets.has(k)) sets.set(k, []); sets.get(k).push(d); }
  if (!sets.size) { tell(t("There are no stems in Studio yet. Make them with the stems button in the Library or the Locker.")); return; }
  const order = Object.keys(STM_NAMES);
  for (const L of sets.values()) L.sort((a, b) => order.indexOf(a.source.stem) - order.indexOf(b.source.stem));
  const rows = [...sets.entries()].map(([k, L]) => `<button type="button" class="vwrow" data-v="${esc(k)}"><b>${esc(L[0].name.replace(/ – [^–]+$/, ""))}</b><span>${esc(L.map(d => t(STM_NAMES[d.source.stem] || d.source.stem)).join(" · "))}</span></button>`).join("");
  const setup = f => f.querySelectorAll(".vwrow").forEach(b => b.addEventListener("click", () => { f.querySelector("[name=pick]").value = b.dataset.v; document.querySelector("#dlg .dok").click(); }));
  const v = await askForm(t("Fill with stems"), `<input type="hidden" name="pick" value=""><div class="vwrows">${rows}</div><div class="dnote">${esc(t("Each stem goes into the column of the same name; a column is added where there is none."))}</div>`, { ok: t("choose"), setup });
  if (!v || !v.pick || !ses.open) return;
  const L = sets.get(v.pick);
  const got = [];
  for (const d of L) { const p = await ssPrepDoc(d.id); if (!p || !ses.open) return; got.push({ d, p }); }
  const row = snData().rows.find(r => r.id === rowId);
  if (!row) return;
  for (const { d, p } of got) {
    const label = t(STM_NAMES[d.source.stem] || d.source.stem);
    let tr = ses.s.tracks.find(x => x.name.toLowerCase() === label.toLowerCase() || x.name.toLowerCase() === String(d.source.stem).toLowerCase());
    if (!tr) { tr = { id: ssNewId(), name: label, gain: 0, pan: 0, mute: false, solo: false, clips: [], takes: [] }; ses.s.tracks.push(tr); }
    row.slots[tr.id] = { id: ssNewId(), doc: p.id, from: 0, len: p.len, name: label, loop: true, gain: 0 };
  }
  ssCommit();
  snRender();
  flash(t("{n} stems in {s}").replace("{n}", got.length).replace("{s}", row.name));
}

async function snChoose(rowId, tid) {
  const id = await snPickDoc(t("Choose a file for the slot"));
  if (!id) return;
  const p = await ssPrepDoc(id);
  if (!p || !ses.open) return;
  const row = snData().rows.find(r => r.id === rowId);
  if (!row || !ses.s.tracks.some(tr => tr.id === tid)) return;
  row.slots[tid] = { id: ssNewId(), doc: p.id, from: 0, len: p.len, name: p.meta.name, loop: true, gain: 0 };
  ssCommit();
  snRender();
}

async function snRename(kind, id) {
  const f = kind === "slot" ? snFind(id) : null, row = kind === "row" ? snData().rows.find(r => r.id === id) : null;
  const cur = f ? f.k.name : row ? row.name : "";
  const v = await askText(kind === "slot" ? t("Rename the slot") : t("Rename the scene"), cur || "");
  if (v === null || v === undefined || !ses.open) return;
  const f2 = kind === "slot" ? snFind(id) : null, row2 = kind === "row" ? snData().rows.find(r => r.id === id) : null;
  if (f2) f2.k.name = String(v).trim().slice(0, 160);
  if (row2) row2.name = String(v).trim().slice(0, 80);
  ssCommit();
  snRender();
}

function snColItems(tid) {
  const tr = ses.s.tracks.find(x => x.id === tid);
  if (!tr) return [];
  return [
    { label: t("Fill from the session's markers"), enabled: (ses.s.marks || []).length > 0 && tr.clips.length > 0, run: () => snFillMarks(tid) },
    { label: t("Fill from a file's markers…"), enabled: true, run: () => snFillFile(tid) },
    { label: t("Fill from the takes"), enabled: (tr.takes || []).length > 0, run: () => snFillTakes(tid) }
  ];
}

function snMenu(e) {
  const head = e.target.closest(".sch[data-tr]");
  if (head) { e.preventDefault(); ctxOpen(e.clientX, e.clientY, snColItems(head.dataset.tr), false); return; }
  const el = e.target.closest(".scs, .scrow[data-row]");
  if (!el) return;
  e.preventDefault();
  const items = [];
  if (el.classList.contains("scrow")) {
    const id = el.dataset.row;
    items.push({ label: t("Launch the scene"), enabled: true, run: () => snRowLaunch(id) }, { label: t("Fill with stems…"), enabled: true, run: () => snFillStems(id) }, { label: t("Rename the scene"), enabled: true, run: () => snRename("row", id) }, { label: t("Remove the scene"), enabled: true, run: () => { const d = snData(); d.rows = d.rows.filter(r => r.id !== id); ssCommit(); snRender(); } });
  } else if (el.dataset.slot) {
    const f = snFind(el.dataset.slot);
    if (!f) return;
    items.push({ label: t("Launch"), enabled: true, run: () => snLaunch([{ tr: f.tid, k: f.k }]) },
      { label: sn.cue && sn.cue.id === f.k.id ? t("Stop the cue") : t("Cue (Alt+click)"), enabled: true, run: () => snCue(f.k) },
      { label: f.k.loop ? t("Play once") : t("Loop"), enabled: true, run: () => { const g = snFind(f.k.id); if (g) { g.k.loop = !g.k.loop; ssCommit(); snRender(); } } },
      { label: t("Rename the slot"), enabled: true, run: () => snRename("slot", f.k.id) },
      { label: t("Open in waveform"), enabled: true, run: () => vwOpenClip(f.k) },
      { label: t("Remove the slot"), enabled: true, run: () => { const g = snFind(f.k.id); if (g) { delete g.row.slots[g.tid]; ssCommit(); snRender(); } } });
  } else {
    items.push({ label: t("Choose a file…"), enabled: true, run: () => snChoose(el.dataset.row, el.dataset.tr) });
  }
  ctxOpen(e.clientX, e.clientY, items, false);
}

function snClick(e) {
  const b = e.target.closest("button, input");
  if (!b) return;
  if (b.tagName === "BUTTON") b.blur();
  const head = b.closest(".sch[data-tr]"), tr = head && ses.s.tracks.find(x => x.id === head.dataset.tr);
  if (b.classList.contains("scstopall")) { ssStop(); return; }
  if (b.classList.contains("scnew")) { snData().rows.push(snNewRow()); ssCommit(); snRender(); return; }
  if (b.classList.contains("scgo")) { snRowLaunch(b.closest(".scrow").dataset.row); return; }
  if (tr && b.classList.contains("scmore")) { const q = b.getBoundingClientRect(); ctxOpen(q.left, q.bottom, snColItems(tr.id), false); return; }
  if (tr && b.classList.contains("scstop")) { if (ses.play.on) snLaunch([{ tr: tr.id, k: null }]); return; }
  if (tr && b.classList.contains("stm")) { tr.mute = !tr.mute; ssCommit(); snRender(); return; }
  if (tr && b.classList.contains("sts")) { tr.solo = !tr.solo; ssCommit(); snRender(); return; }
  if (b.classList.contains("scs")) {
    if (b.classList.contains("empty")) { snChoose(b.dataset.row, b.dataset.tr); return; }
    const f = snFind(b.dataset.slot);
    if (f && e.altKey) { snCue(f.k); return; }
    if (f) snLaunch([{ tr: f.tid, k: f.k }]);
  }
}

function wireScenes() {
  const g = $("scGrid");
  g.addEventListener("click", snClick);
  g.addEventListener("contextmenu", snMenu);
  g.addEventListener("dblclick", e => { const n = e.target.closest(".scrn"); if (n) snRename("row", n.closest(".scrow").dataset.row); });
  g.addEventListener("input", e => { const i = e.target.closest(".scvol"); if (!i) return; const tr = ses.s.tracks.find(x => x.id === i.closest(".sch").dataset.tr); if (tr) { tr.gain = Number(i.value) <= -48 ? -96 : Number(i.value); ssMix(); } });
  g.addEventListener("change", e => { if (e.target.closest(".scvol")) ssCommit(); });
  document.addEventListener("i18n", () => { if (ses.open && ses.mode === "scenes") { $("scBar").dataset.wired = ""; sn.built = ""; snRender(); } });
}

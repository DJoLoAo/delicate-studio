const sn = { ev: new Map(), taps: [], built: "" };

function snData() {
  if (!ses.s.scenes || typeof ses.s.scenes !== "object") ses.s.scenes = { tempo: 120, quant: "bar", rows: [] };
  const d = ses.s.scenes;
  if (!Array.isArray(d.rows)) d.rows = [];
  if (!Number.isFinite(d.tempo)) d.tempo = 120;
  if (!["bar", "beat", "off"].includes(d.quant)) d.quant = "bar";
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
  const key = JSON.stringify([d.rows, ses.s.tracks.map(tr => [tr.id, tr.name, tr.mute, tr.solo, tr.gain]), ses.s.sr]);
  if (key === sn.built) { snTick(ses.play.on ? ssPlayhead() : 0); return; }
  sn.built = key;
  const g = $("scGrid"), T = ses.s.tracks;
  g.style.gridTemplateColumns = "calc(150px*var(--fs)) repeat(" + Math.max(1, T.length) + ", minmax(calc(130px*var(--fs)), 1fr))";
  const h = [`<div class="sch sccorner"><button type="button" class="scstopall" title="${esc(t("Stop all"))}">■ ${esc(t("Stop all"))}</button></div>`];
  T.forEach((tr, i) => {
    h.push(`<div class="sch" data-tr="${esc(tr.id)}"><div class="sch1"><i class="sdot" style="background:${tc(SS_COLORS[i % SS_COLORS.length])}"></i><span class="schn">${esc(tr.name)}</span><button type="button" class="stm${tr.mute ? " on" : ""}" title="${esc(t("Mute"))}">M</button><button type="button" class="sts${tr.solo ? " on" : ""}" title="${esc(t("Solo"))}">S</button><button type="button" class="scstop" title="${esc(t("Stop this track"))}">■</button></div><input type="range" class="scvol" min="-48" max="12" step="0.5" value="${Math.max(-48, tr.gain)}" title="${esc(t("Vol"))}"></div>`);
  });
  if (!T.length) h.push(`<div class="sch scnote">${esc(t("Add a track first: each track is a column."))}</div>`);
  d.rows.forEach((row, r) => {
    h.push(`<div class="scrow" data-row="${esc(row.id)}"><button type="button" class="scgo" title="${esc(t("Launch the scene"))}">▶</button><span class="scrn">${esc(row.name || t("Scene") + " " + (r + 1))}</span></div>`);
    T.forEach((tr, i) => {
      const k = row.slots[tr.id];
      if (!k) { h.push(`<button type="button" class="scs empty" data-row="${esc(row.id)}" data-tr="${esc(tr.id)}" title="${esc(t("Choose a file…"))}"></button>`); return; }
      h.push(`<button type="button" class="scs" data-row="${esc(row.id)}" data-tr="${esc(tr.id)}" data-slot="${esc(k.id)}" style="--c:${tc(SS_COLORS[i % SS_COLORS.length])}"><span class="scsn">${esc(k.name || t("Clip"))}</span><span class="scsi">${k.loop ? "⟳ " : "→ "}${esc(snLenText(k))}</span><i class="scp"></i></button>`);
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
    b.innerHTML = `<label class="sctempo"><span>${esc(t("Tempo"))}</span><input id="scTempo" inputmode="decimal" spellcheck="false" autocomplete="off"><b>BPM</b></label><button type="button" class="outbtn" id="scTap">${esc(t("tap"))}</button>${segHtml("q", [["bar", "Bar"], ["beat", "Beat"], ["off", "Off"]], d.quant).replace('class="seg dseg"', 'class="seg" id="scQuant"')}<span class="grow"></span><button type="button" class="outbtn" id="scFill">${esc(t("Fill from the multitrack"))}</button>`;
    const ti = $("scTempo");
    ti.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); ti.blur(); } e.stopPropagation(); });
    ti.addEventListener("change", () => { const v = Number(String(ti.value).replace(",", ".")); if (Number.isFinite(v)) snSetTempo(v); else ti.value = snData().tempo; });
    $("scTap").addEventListener("click", e => { e.currentTarget.blur(); snTap(); });
    $("scQuant").addEventListener("click", e => { const x = e.target.closest("button"); if (!x) return; x.blur(); snData().quant = x.dataset.v; ssCommit(); snBar(snData()); });
    $("scFill").addEventListener("click", e => { e.currentTarget.blur(); snFill(); });
  }
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
      const q = ph - st.cur.at;
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
  const wire = items.map(it => ({ tr: it.tr, k: it.k ? Object.assign({}, it.k) : null }));
  if (!ses.play.on) { await snPlay(wire); return; }
  ed.worker.postMessage({ t: "sclaunch", items: wire, q: snQ() });
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
    L.push({ at: it.at, k: it.k });
    sn.ev.set(it.tr, L);
  }
}

function snStopped() { sn.ev = new Map(); snTick(0); }

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

async function snChoose(rowId, tid) {
  let docs = [];
  try { docs = (await call({ t: "list" })).docs.filter(d => !d.recording); } catch {}
  if (!docs.length) { tell(t("There are no files in Studio yet. Open or record one first.")); return; }
  const rows = docs.slice(0, 200).map(d => `<button type="button" class="vwrow" data-v="${esc(d.id)}"><b>${esc(d.name)}</b><span>${esc(((d.sampleRate || 0) / 1000).toLocaleString() + " kHz · " + fmtDur((d.len || d.frames || 0) / (d.sampleRate || 48000)))}</span></button>`).join("");
  const setup = f => f.querySelectorAll(".vwrow").forEach(b => b.addEventListener("click", () => { f.querySelector("[name=pick]").value = b.dataset.v; document.querySelector("#dlg .dok").click(); }));
  const v = await askForm(t("Choose a file for the slot"), `<input type="hidden" name="pick" value=""><div class="vwrows">${rows}</div>`, { ok: t("choose"), setup });
  if (!v || !v.pick || !ses.open) return;
  const p = await ssPrepDoc(v.pick);
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

function snMenu(e) {
  const el = e.target.closest(".scs, .scrow[data-row]");
  if (!el) return;
  e.preventDefault();
  const items = [];
  if (el.classList.contains("scrow")) {
    const id = el.dataset.row;
    items.push({ label: t("Launch the scene"), enabled: true, run: () => snRowLaunch(id) }, { label: t("Rename the scene"), enabled: true, run: () => snRename("row", id) }, { label: t("Remove the scene"), enabled: true, run: () => { const d = snData(); d.rows = d.rows.filter(r => r.id !== id); ssCommit(); snRender(); } });
  } else if (el.dataset.slot) {
    const f = snFind(el.dataset.slot);
    if (!f) return;
    items.push({ label: t("Launch"), enabled: true, run: () => snLaunch([{ tr: f.tid, k: f.k }]) },
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
  if (tr && b.classList.contains("scstop")) { if (ses.play.on) snLaunch([{ tr: tr.id, k: null }]); return; }
  if (tr && b.classList.contains("stm")) { tr.mute = !tr.mute; ssCommit(); snRender(); return; }
  if (tr && b.classList.contains("sts")) { tr.solo = !tr.solo; ssCommit(); snRender(); return; }
  if (b.classList.contains("scs")) {
    if (b.classList.contains("empty")) { snChoose(b.dataset.row, b.dataset.tr); return; }
    const f = snFind(b.dataset.slot);
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

const vw = { doc: null, ses: null, hist: new Map(), busy: false };

function vwLoad() {
  try { vw.doc = localStorage.getItem("studioWaveDoc") || null; vw.ses = localStorage.getItem("studioMultiSes") || null; } catch {}
}

function vwNoteDoc(id) { vw.doc = id; try { localStorage.setItem("studioWaveDoc", id); } catch {} }
function vwNoteSes(id) { vw.ses = id; try { localStorage.setItem("studioMultiSes", id); } catch {} }

function vwForgetDoc(id) { if (vw.doc === id) { vw.doc = null; try { localStorage.removeItem("studioWaveDoc"); } catch {} } }
function vwForgetSes(id) { vw.hist.delete(id); if (vw.ses === id) { vw.ses = null; try { localStorage.removeItem("studioMultiSes"); } catch {} } }

function vwKeep() {
  if (!ses.open || !ses.s) return;
  vw.hist.delete(ses.s.id);
  vw.hist.set(ses.s.id, { hist: ses.hist.slice(), idx: ses.idx });
  while (vw.hist.size > 6) vw.hist.delete(vw.hist.keys().next().value);
}

function vwRestore() {
  const h = ses.s && vw.hist.get(ses.s.id);
  if (!h || !h.hist.length) return;
  ses.hist = h.hist.slice();
  ses.idx = Math.min(h.idx, ses.hist.length - 1);
  ses.hist[ses.idx] = ssSnap();
}

function vwFit(s) {
  const cut = [];
  for (const tr of s.tracks) {
    const keep = [];
    for (const k of tr.clips) {
      const M = ses.docs.get(k.doc);
      if (!M || M.missing || k.from + k.len <= M.len) { keep.push(k); continue; }
      if (k.from >= M.len - 1) { cut.push(k.name || tr.name); continue; }
      k.len = M.len - k.from;
      k.fin = Math.min(k.fin, k.len);
      k.fout = Math.min(k.fout, k.len - k.fin);
      keep.push(k);
      cut.push(k.name || tr.name);
    }
    tr.clips = keep;
  }
  return cut;
}

function vwView() { return ses.open ? (ses.mode === "scenes" ? "scenes" : "multi") : ed.doc ? "wave" : ""; }

function vwRender() {
  const v = vwView();
  document.querySelectorAll("#viewSw button").forEach(b => b.classList.toggle("on", b.dataset.v === v));
}

async function vwWave() {
  if (vw.busy || !ses.open) { if (!ses.open && !ed.doc && vw.doc) await vwOpenDoc(vw.doc); return; }
  vw.busy = true;
  try {
    const id = vw.doc;
    if (id && (await vwHasDoc(id))) { await openDoc(id); return; }
    vwForgetDoc(id);
    await ssClose();
  } finally { vw.busy = false; vwRender(); }
}

async function vwHasDoc(id) {
  try { return (await call({ t: "list" })).docs.some(d => d.id === id); } catch { return false; }
}

async function vwOpenDoc(id) {
  if (await vwHasDoc(id)) await openDoc(id);
  else vwForgetDoc(id);
}

async function vwMulti(mode) {
  mode = mode === "scenes" ? "scenes" : "multi";
  if (vw.busy) return;
  if (ses.open) { if (ses.mode !== mode) snMode(mode); return; }
  vw.busy = true;
  try {
    const list = await ssLoadList();
    if (vw.ses && list.some(s => s.id === vw.ses)) await ssOpen(vw.ses);
    else {
      vwForgetSes(vw.ses);
      const pick = await vwPick(list);
      if (pick === "new") await vwInsert(true);
      else if (pick) await ssOpen(pick);
    }
    if (ses.open && ses.mode !== mode) snMode(mode);
  } finally { vw.busy = false; vwRender(); }
}

function vwScenes() { return vwMulti("scenes"); }

async function vwPick(list) {
  const rows = [];
  if (ed.doc) rows.push(`<button type="button" class="vwrow" data-v="new"><b>${esc(t("New session with this file"))}</b><span>${esc(ed.doc.name)}</span></button>`);
  else rows.push(`<button type="button" class="vwrow" data-v="empty"><b>${esc(t("New session"))}</b><span>${esc(t("Add files or record into it."))}</span></button>`);
  for (const s of list.slice(0, 30)) {
    const info = [s.sr ? (s.sr / 1000).toLocaleString() + " kHz" : "", s.tracks === 1 ? t("1 track") : t("{n} tracks").replace("{n}", s.tracks), s.sr ? fmtDur(s.len / s.sr) : ""].filter(Boolean).join(" · ");
    rows.push(`<button type="button" class="vwrow" data-v="${esc(s.id)}"><b>${esc(s.name)}</b><span>${esc(info)}</span></button>`);
  }
  const html = `<input type="hidden" name="pick" value=""><div class="vwrows">${rows.join("")}</div>`;
  const setup = f => f.querySelectorAll(".vwrow").forEach(b => b.addEventListener("click", () => { f.querySelector("[name=pick]").value = b.dataset.v; document.querySelector("#dlg .dok").click(); }));
  const v = await askForm(t("Multitrack"), html, { ok: t("open"), setup });
  if (!v || !v.pick) return null;
  if (v.pick === "empty") { await ssNew(t("New session")); return null; }
  return v.pick;
}

async function vwInsert(fresh) {
  if (!ed.doc) return;
  const doc = ed.doc, sel = ed.sel.b > ed.sel.a ? { a: ed.sel.a, b: ed.sel.b } : null, sr = doc.sampleRate;
  const list = fresh ? [] : await ssLoadList();
  const target = !fresh && vw.ses && list.some(s => s.id === vw.ses) ? vw.ses : null;
  if (target) await ssOpen(target);
  else await ssNew(doc.name.replace(/\.[^.]+$/, "") || t("New session"));
  if (!ses.open) return;
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const tr = await ssAddDoc(doc.id, ses.cursor, sel ? { a: sel.a / sr, b: sel.b / sr } : null);
  if (!tr) return;
  ssEnsure(tr.clips[0].at);
  ssDraw();
}

async function vwOpenClip(k) {
  if (!k || vw.busy) return;
  const M = ses.docs.get(k.doc);
  if (!M || M.missing) { flash(t("This file is no longer in Studio.")); return; }
  vw.busy = true;
  try {
    const a = k.from, b = k.from + k.len;
    await openDoc(k.doc);
    if (!ed.doc || ed.doc.id !== k.doc) return;
    setSelFrom({ a, b });
    zoomSel();
  } finally { vw.busy = false; vwRender(); }
}

function wireView() {
  vwLoad();
  document.querySelectorAll("#viewSw button").forEach(b => b.addEventListener("click", e => { e.currentTarget.blur(); if (b.dataset.v === "wave") vwWave(); else if (b.dataset.v === "scenes") vwScenes(); else vwMulti(); }));
  vwRender();
}

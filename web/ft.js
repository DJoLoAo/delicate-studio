const FT_FIELDS = [["TITLE", "Title"], ["ARTIST", "Artist"], ["ALBUMARTIST", "Album artist"], ["ALBUM", "Album"], ["TRACKNUMBER", "Track"], ["DATE", "Date"], ["GENRE", "Genre"], ["STYLE", "Styles"], ["ORGANIZATION", "Label"], ["CATALOGNUMBER", "Catalog number"], ["COMMENT", "Comment"]];
const FT_MULTI = new Set(["GENRE", "STYLE"]);
const FT_STD = new Set(FT_FIELDS.map(f => f[0]).concat(["ALBUM ARTIST"]));
const FT_MAX = 4 << 20;

const ft = { doc: null, back: false, cover: undefined, url: null, base: "", busy: false, results: null, err: null };

function ftVal(tags, k) {
  if (FT_MULTI.has(k)) return tgAll(tags, k).join(", ");
  if (k === "ALBUMARTIST") return tgGet(tags, "ALBUMARTIST") || tgGet(tags, "ALBUM ARTIST");
  return tgGet(tags, k);
}

function ftInput(name, value, cls, ph) {
  const i = document.createElement("input");
  i.className = "xtext " + (cls || "");
  i.value = value || "";
  if (name) i.name = name;
  if (ph) i.placeholder = ph;
  i.autocomplete = "off";
  i.spellcheck = false;
  return i;
}

function ftMoreRow(k, v) {
  const row = document.createElement("div");
  row.className = "tgrow";
  const x = document.createElement("button");
  x.className = "x";
  x.type = "button";
  x.textContent = "×";
  x.title = t("Remove");
  x.setAttribute("aria-label", t("Remove"));
  x.addEventListener("click", () => row.remove());
  row.append(ftInput("", k, "tgk", t("name")), ftInput("", v, "tgv", t("value")), x);
  $("tagMore").appendChild(row);
  return row;
}

function ftFill(tags) {
  const box = $("tagFields");
  box.textContent = "";
  for (const [k, label] of FT_FIELDS) {
    const l = document.createElement("label");
    l.textContent = t(label);
    l.htmlFor = "tag_" + k;
    const i = ftInput(k, ftVal(tags, k), "", FT_MULTI.has(k) ? t("several separated by commas") : "");
    i.id = "tag_" + k;
    box.append(l, i);
  }
  $("tagMore").textContent = "";
  for (const [k, v] of tags) if (!FT_STD.has(k)) ftMoreRow(k, v);
}

function ftRead() {
  const out = [];
  for (const [k] of FT_FIELDS) {
    const v = $("tag_" + k).value.trim();
    if (!v) continue;
    if (FT_MULTI.has(k)) { for (const p of v.split(",")) out.push([k, p.trim()]); }
    else out.push([k, v]);
    if (k === "ALBUMARTIST") out.push(["ALBUM ARTIST", v]);
  }
  for (const row of $("tagMore").querySelectorAll(".tgrow")) {
    const k = tgKey(row.querySelector(".tgk").value), v = row.querySelector(".tgv").value.trim();
    if (k && v && !FT_STD.has(k)) out.push([k, v]);
  }
  return tgClean(out);
}

function ftState() {
  return JSON.stringify(ftRead()) + (ft.cover === undefined ? "" : ft.cover === null ? "|none" : "|" + ft.cover.data.byteLength);
}

function ftShow(c) {
  if (ft.url) { URL.revokeObjectURL(ft.url); ft.url = null; }
  const img = $("tagImg");
  if (c && c.data) {
    ft.url = URL.createObjectURL(new Blob([c.data], { type: c.mime }));
    img.src = ft.url;
  } else img.removeAttribute("src");
  img.classList.toggle("hidden", !c);
  $("tagNoImg").classList.toggle("hidden", !!c);
  $("tagRm").disabled = !c;
  $("tagImgInfo").textContent = c ? [c.w && c.h ? c.w + " × " + c.h : "", c.mime === "image/png" ? "PNG" : "JPEG", fmtBytes(c.data.byteLength)].filter(Boolean).join(" · ") : "";
}

async function ftOpen(back) {
  if (!ed.doc) return;
  let r;
  try { r = await call({ t: "tagsget", id: ed.doc.id }); }
  catch (e) { editError(e); return; }
  closePopovers();
  if (back) closeExport();
  ft.doc = ed.doc.id;
  ft.back = !!back;
  ft.cover = undefined;
  ft.results = null;
  ft.err = null;
  ftFill(r.tags || []);
  ftShow(r.cover || null);
  ftHits();
  $("tagQ").value = [ftVal(r.tags, "ARTIST") || ftVal(r.tags, "ALBUMARTIST"), ftVal(r.tags, "ALBUM")].filter(Boolean).join(" - ");
  $("tagInfo").textContent = t("Kept with this file in Studio and written into the files you export.");
  $("tagDc").textContent = t("Fills album, artist, date, genre, style, label, catalog number and cover from the release.");
  $("tagp").classList.remove("hidden");
  ft.base = ftState();
  setTimeout(() => { const i = $("tag_TITLE"); if (i) i.focus(); }, 30);
}

function ftIsOpen() { return !$("tagp").classList.contains("hidden"); }

function ftHide() {
  $("tagp").classList.add("hidden");
  if (ft.url) { URL.revokeObjectURL(ft.url); ft.url = null; }
  const back = ft.back;
  ft.back = false;
  ft.doc = null;
  if (back && ed.doc) openExport();
}

async function ftClose() {
  if (!ftIsOpen()) return;
  if (ftState() !== ft.base && !(await ask(t("Discard the changes?"), t("The tags you changed are not saved."), { ok: t("discard") }))) return;
  ftHide();
}

async function ftSave() {
  if (!ed.doc || ft.doc !== ed.doc.id || ft.busy) return;
  ft.busy = true;
  $("tagSave").disabled = true;
  try {
    const msg = { t: "tagsset", id: ed.doc.id, tags: ftRead() };
    if (ft.cover !== undefined) msg.cover = ft.cover;
    const r = await call(msg);
    ed.doc.tags = r.tags;
    ed.doc.cover = r.cover;
    delete xp.docPics[ed.doc.id];
    flash(t("Tags saved"));
    ftHide();
  } catch (e) {
    tell(e && e.message === "cover" ? t("Use a JPEG or PNG image up to 4 MB.") : (e && e.message) || String(e), t("Could not save the tags"));
  } finally {
    ft.busy = false;
    $("tagSave").disabled = false;
  }
}

async function ftCoverFile(f) {
  if (!f) return;
  if (!/^image\/(jpeg|png)$/.test(f.type) || f.size > FT_MAX) { tell(t("Use a JPEG or PNG image up to 4 MB.")); return; }
  let w = 0, h = 0;
  try { const bm = await createImageBitmap(f); w = bm.width; h = bm.height; bm.close(); } catch {}
  ft.cover = { mime: f.type, w, h, data: await f.arrayBuffer() };
  ftShow(ft.cover);
}

function ftSet(k, v, force) {
  const s = String(v == null ? "" : v).trim();
  if (!s || s === "0") return;
  const i = $("tag_" + k);
  if (i) { if (force || !i.value.trim()) i.value = s; return; }
  for (const row of $("tagMore").querySelectorAll(".tgrow")) if (tgKey(row.querySelector(".tgk").value) === k) { row.querySelector(".tgv").value = s; return; }
  ftMoreRow(k, s);
}

async function ftUse(rel) {
  if (!rel) return;
  ftSet("ALBUM", rel.title, true);
  ftSet("ALBUMARTIST", rel.artist, true);
  ftSet("ARTIST", rel.artist);
  ftSet("TITLE", rel.title);
  ftSet("DATE", rel.year, true);
  ftSet("GENRE", rel.genre, true);
  ftSet("STYLE", rel.style, true);
  ftSet("ORGANIZATION", rel.label, true);
  ftSet("CATALOGNUMBER", rel.catno, true);
  ftSet("MEDIA", String(rel.format || "").split(",")[0], true);
  ftSet("CUSTOM2", rel.id, true);
  ftSet("CUSTOM4", rel.country, true);
  ftSet("CUSTOM5", rel.format, true);
  ft.results = null;
  ftHits();
  if (rel.cover) {
    const pic = await xpPic(rel.cover);
    if (pic && ftIsOpen()) { ft.cover = { mime: pic.mime, w: pic.w, h: pic.h, data: pic.data.slice(0) }; ftShow(ft.cover); }
  }
  $("tagDc").textContent = t("Filled from Discogs") + ": " + [rel.artist, rel.title].filter(Boolean).join(" – ") + (rel.year ? " (" + rel.year + ")" : "");
}

function ftHits() {
  const box = $("tagRes"), res = ft.results;
  box.classList.toggle("hidden", !res && !ft.err);
  box.textContent = "";
  if (ft.err) { const p = document.createElement("div"); p.className = "snote"; p.textContent = ft.err; box.appendChild(p); return; }
  if (!res) return;
  if (!res.length) {
    const p = document.createElement("div");
    p.className = "snote";
    p.textContent = t("No release found. Try artist - title, the catalog number or a Discogs link.");
    box.appendChild(p);
    return;
  }
  for (const h of res.slice(0, 15)) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "trhit";
    const img = document.createElement(h.cover ? "img" : "span");
    img.className = "trthumb";
    if (h.cover) { img.src = trImg(h.cover); img.alt = ""; img.loading = "lazy"; }
    const txt = document.createElement("span");
    txt.className = "trht";
    const b = document.createElement("b");
    b.textContent = [h.artist, h.title].filter(Boolean).join(" – ") || String(h.id);
    const s = document.createElement("span");
    s.textContent = [h.year || "", h.label, h.catno, h.country, h.format].filter(Boolean).join(" · ");
    txt.append(b, s);
    row.append(img, txt);
    row.addEventListener("click", () => ftPick(h.id));
    box.appendChild(row);
  }
}

async function ftSearch() {
  const q = $("tagQ").value.trim();
  if (!q || ft.busy) return;
  if (!(await trDiscogs()).connected && !(await trConnect())) return;
  ft.busy = true;
  ft.err = null;
  ft.results = null;
  $("tagSearch").disabled = true;
  try {
    const j = await trFetch("/api/locker/discogs/search?q=" + encodeURIComponent(q));
    const res = Array.isArray(j.results) ? j.results : [];
    if (res.length === 1 && Array.isArray(res[0].tracks)) { ft.busy = false; await ftUse(res[0]); }
    else ft.results = res;
  } catch (e) {
    if (e.message !== "token") ft.err = t("Discogs search failed") + ": " + e.message;
  } finally {
    ft.busy = false;
    $("tagSearch").disabled = false;
    ftHits();
  }
}

async function ftPick(id) {
  if (ft.busy) return;
  ft.busy = true;
  ft.err = null;
  try { const rel = await trFetch("/api/locker/discogs/release/" + encodeURIComponent(id)); ft.busy = false; await ftUse(rel); }
  catch (e) { if (e.message !== "token") ft.err = t("Discogs search failed") + ": " + e.message; }
  finally { ft.busy = false; ftHits(); }
}

function ftCuePick() {
  if (!ed.doc) return;
  $("cueIn").click();
}

async function ftCueFile(f) {
  if (!ed.doc || !f) return;
  const buf = new Uint8Array(await f.arrayBuffer());
  let text;
  try { text = new TextDecoder("utf-8", { fatal: true }).decode(buf); } catch { text = new TextDecoder("windows-1252").decode(buf); }
  const cue = tgCue(text);
  if (!cue.tracks.length) { tell(t("This cue sheet has no tracks."), t("Could not import the cue sheet")); return; }
  const stem = s => String(s).split(/[\\/]/).pop().replace(/\.[^.]+$/, "").toLowerCase();
  const file = cue.files.find(x => stem(x) === stem(ed.doc.name)) || cue.files[0];
  const ranges = tgCueRanges(cue, ed.doc.sampleRate, ed.doc.frames, file);
  if (!ranges.length) { tell(t("The tracks in this cue sheet start after the end of this file."), t("Could not import the cue sheet")); return; }
  const old = (ed.marks || []).filter(m => m.kind === "range").length;
  if (old) {
    const msg = old === 1 ? t("This file has 1 range. The tracks replace it.") : t("This file has {n} ranges. The tracks replace them.").replace("{n}", old);
    if (!(await ask(t("Replace the ranges?"), msg, { ok: t("Replace") }))) return;
  }
  const r = await runEdit({ t: "edit", op: "marktracks", tracks: ranges }, false, true);
  if (!r) return;
  const tags = (ed.doc.tags || []).slice(), have = new Set(tags.map(x => x[0]));
  const add = [["ALBUM", cue.title], ["ALBUMARTIST", cue.performer], ["ALBUM ARTIST", cue.performer], ["ARTIST", cue.performer], ["DATE", cue.date], ["GENRE", cue.genre]].filter(([k, v]) => v && !have.has(k));
  if (add.length) {
    try { const s = await call({ t: "tagsset", id: ed.doc.id, tags: tags.concat(add) }); ed.doc.tags = s.tags; } catch {}
  }
  flash((ranges.length === 1 ? t("1 track as a range") : t("{n} tracks as ranges").replace("{n}", ranges.length)) + " · " + f.name);
}

function ftDrop(files) {
  const img = [...files].find(f => /^image\/(jpeg|png)$/.test(f.type));
  if (img) ftCoverFile(img);
}

function wireTags() {
  $("tagClose").addEventListener("click", ftClose);
  $("tagCancel").addEventListener("click", ftClose);
  $("tagSave").addEventListener("click", ftSave);
  $("tagp").addEventListener("pointerdown", e => { if (e.target === $("tagp")) ftClose(); });
  $("tagp").addEventListener("keydown", e => {
    if (e.key === "Escape") { e.stopPropagation(); ftClose(); }
    else if (e.key === "Enter" && e.target.id === "tagQ") { e.preventDefault(); ftSearch(); }
    else if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); ftSave(); }
  });
  $("tagAdd").addEventListener("click", () => { const row = ftMoreRow("", ""); row.querySelector(".tgk").focus(); });
  $("tagSearch").addEventListener("click", ftSearch);
  $("tagCover").addEventListener("click", () => $("tagFile").click());
  $("tagPick").addEventListener("click", () => $("tagFile").click());
  $("tagRm").addEventListener("click", () => { ft.cover = null; ftShow(null); });
  $("tagFile").addEventListener("change", e => { ftCoverFile(e.target.files[0]); e.target.value = ""; });
  const cov = $("tagCover");
  cov.addEventListener("dragover", e => { e.preventDefault(); cov.classList.add("over"); });
  cov.addEventListener("dragleave", () => cov.classList.remove("over"));
  cov.addEventListener("drop", () => cov.classList.remove("over"));
  $("cueIn").addEventListener("change", e => { ftCueFile(e.target.files[0]); e.target.value = ""; });
  $("docName").addEventListener("click", () => ftOpen(false));
}

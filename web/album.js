const al = { list: [], cur: null, infos: {}, busy: false, results: null, err: null };

async function alLoad() {
  try { al.list = (await call({ t: "albums" })).albums || []; } catch { al.list = []; }
  return al.list;
}

async function alSave() {
  try { al.list = (await call({ t: "albumsput", albums: al.list })).albums; }
  catch (e) { tell(String(e.message || e), t("Could not save the album")); }
  if (al.cur) al.cur = al.list.find(a => a.id === al.cur.id) || null;
}

function alOf(id) {
  return id ? al.list.find(a => a.sides.includes(id)) || null : null;
}

async function alInfos(A) {
  if (!A.sides.length) return;
  const r = await call({ t: "docinfo", ids: A.sides });
  for (const d of r.docs) al.infos[d.id] = d;
}

function alRelSides(A) {
  const rel = A.release;
  return rel && Array.isArray(rel.tracks) ? trSides(rel.tracks) : [];
}

function alLetters(A) {
  const ks = alRelSides(A).map(s => s.k).filter(Boolean);
  return A.sides.map((_, i) => ks[i] || String.fromCharCode(65 + i));
}

function alRelSide(A, i, k) {
  const ss = alRelSides(A);
  if (!ss.length) return null;
  if (ss.every(s => !s.k)) return i === 0 ? ss[0].tracks : [];
  const s = ss.find(x => x.k === k);
  return s ? s.tracks : [];
}

function alTitle(A) {
  if (A.title) return A.title;
  if (A.release && A.release.title) return A.release.title;
  const d = al.infos[A.sides[0]];
  return d && !d.error ? tgGet(d.tags || [], "ALBUM") || d.name.replace(/\.[^.]+$/, "") : t("Album");
}

function alArtist(A) {
  if (A.release && A.release.artist) return A.release.artist;
  const d = al.infos[A.sides[0]], tg = d && !d.error ? d.tags || [] : [];
  return tgGet(tg, "ALBUMARTIST") || tgGet(tg, "ARTIST");
}

function alPick(...v) {
  for (const x of v) if (x !== undefined && x !== null && String(x).trim() && String(x) !== "0") return String(x).trim();
  return "";
}

function alTag(m, s, j, A) {
  const rel = A.release || {}, g = m.tag || {}, pos = g.pos || s.letter + (j + 1);
  const rt = (rel.tracks || []).find(x => x.position === pos) || null;
  const tag = {
    name: m.name, pos, title: alPick(g.title, rt && rt.title, xpTitle({ range: m.name, tag: m.tag })), artist: alPick(g.artist, rt && rt.artist, rel.artist, A.artist),
    album: A.named ? A.title : alPick(rel.title, g.album, A.title), albumArtist: alPick(rel.artist, g.albumArtist, A.artist), year: alPick(rel.year, g.year), label: alPick(rel.label, g.label),
    catno: alPick(rel.catno, g.catno), country: alPick(rel.country, g.country), genre: alPick(rel.genre, g.genre), style: alPick(rel.style, g.style), format: alPick(rel.format, g.format),
    release: alPick(rel.id, g.release), cover: alPick(rel.cover, g.cover), isrc: alPick(g.isrc)
  };
  if (A.ndisc > 1) { tag.disc = String(s.disc); tag.discs = String(A.ndisc); }
  return tag;
}

function alSideTracks(A, i) {
  const d = al.infos[A.sides[i]], k = alLetters(A)[i];
  if (!d || d.error) return [];
  return (d.marks || []).filter(m => m.kind === "range").sort((x, y) => x.a - y.a).map((m, j) => {
    const g = m.tag || {};
    return { m, pos: g.pos || k + (j + 1), title: alPick(g.title, xpTitle({ range: m.name, tag: m.tag })), artist: g.artist || "", len: (m.b - m.a) / d.sampleRate };
  });
}

async function alNew() {
  const A = { id: "", title: "", release: null, sides: [], created: Date.now() };
  if (ed.doc && !alOf(ed.doc.id)) {
    A.sides.push(ed.doc.id);
    const rel = tr.rel && (ed.marks || []).some(m => m.tag && String(m.tag.release) === String(tr.rel.id)) ? tr.rel : null;
    if (rel) A.release = rel;
  }
  al.list.push(A);
  await alSave();
  await alOpen(al.list[al.list.length - 1].id);
}

async function alOpen(id) {
  await alLoad();
  try { ed.docs = (await call({ t: "list" })).docs; } catch {}
  const A = al.list.find(a => a.id === id);
  if (!A) return;
  al.cur = A;
  al.results = null;
  al.err = null;
  closeFiles();
  closePopovers();
  await alInfos(A);
  $("albQ").value = [alArtist(A), alTitle(A)].filter(Boolean).join(" - ");
  $("alb").classList.remove("hidden");
  alRender();
}

function alOpenFor(docId) {
  const A = alOf(docId);
  if (A) alOpen(A.id);
}

function alIsOpen() { return !$("alb").classList.contains("hidden"); }

function alHide() {
  $("alb").classList.add("hidden");
  al.cur = null;
}

function alEl(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

function alBtn(label, title, fn, cls) {
  const b = alEl("button", cls || "outbtn", label);
  b.type = "button";
  if (title) { b.title = title; b.setAttribute("aria-label", title); }
  b.addEventListener("click", fn);
  return b;
}

function alRenderRel(A) {
  const rel = A.release, box = $("albRel"), img = $("albCover");
  box.textContent = "";
  img.classList.toggle("hidden", !(rel && rel.cover));
  if (rel && rel.cover) img.src = trImg(rel.cover);
  $("albRelClear").classList.toggle("hidden", !rel);
  if (!rel) { box.appendChild(alEl("span", "snote", t("No Discogs release yet. Search for it to name the tracks of every side."))); return; }
  box.appendChild(alEl("b", "", [rel.artist, rel.title].filter(Boolean).join(" – ")));
  box.appendChild(alEl("span", "snote", [rel.year || "", rel.label, rel.catno, rel.country, rel.format].filter(Boolean).join(" · ") + " · " + (rel.tracks || []).length + " " + t("tracks on Discogs")));
}

function alRenderHits() {
  const box = $("albRes"), res = al.results;
  box.classList.toggle("hidden", !res && !al.err);
  box.textContent = "";
  if (al.err) { box.appendChild(alEl("div", "snote", al.err)); return; }
  if (!res) return;
  if (!res.length) { box.appendChild(alEl("div", "snote", t("No release found. Try artist - title, the catalog number or a Discogs link."))); return; }
  for (const h of res.slice(0, 15)) {
    const row = alEl("button", "trhit");
    row.type = "button";
    const img = alEl(h.cover ? "img" : "span", "trthumb");
    if (h.cover) { img.src = trImg(h.cover); img.alt = ""; img.loading = "lazy"; }
    const txt = alEl("span", "trht");
    txt.append(alEl("b", "", [h.artist, h.title].filter(Boolean).join(" – ") || String(h.id)), alEl("span", "", [h.year || "", h.label, h.catno, h.country, h.format].filter(Boolean).join(" · ")));
    row.append(img, txt);
    row.addEventListener("click", () => alPickRel(h.id));
    box.appendChild(row);
  }
}

function alStatus(A, i, tracks) {
  const d = al.infos[A.sides[i]], k = alLetters(A)[i], want = alRelSide(A, i, k);
  if (!d) return { text: t("Loading…"), ok: false };
  if (d.error) return { text: t("This file is no longer in Studio."), ok: false };
  if (!tracks.length) return { text: t("No tracks yet"), ok: false };
  if (want && want.length) {
    const got = want.filter(x => tracks.some(r => r.pos === x.position)).length;
    return got === want.length && tracks.length === want.length ? { text: t("All tracks of side {k}").replace("{k}", k), ok: true } : { text: t("{n} of {m} tracks of side {k}").replace("{n}", got).replace("{m}", want.length).replace("{k}", k), ok: false };
  }
  return { text: tracks.length === 1 ? t("1 track") : t("{n} tracks").replace("{n}", tracks.length), ok: true };
}

function alRenderSides(A) {
  const box = $("albSides"), letters = alLetters(A);
  box.textContent = "";
  if (!A.sides.length) box.appendChild(alEl("div", "snote", t("Add the files of this record, one per side.")));
  A.sides.forEach((id, i) => {
    const d = al.infos[id], tracks = alSideTracks(A, i), st = alStatus(A, i, tracks);
    const row = alEl("div", "albside");
    row.appendChild(alEl("span", "albk", letters[i]));
    const name = alBtn(d && !d.error ? d.name : t("Missing file"), t("Open this side"), () => alGo(i), "albname");
    name.disabled = !d || !!d.error;
    const info = alEl("span", "albinfo");
    info.append(name, alEl("span", "snote", (d && !d.error ? fmtDur(d.frames / d.sampleRate) + " · " : "") + st.text));
    info.lastChild.classList.toggle("ok", st.ok);
    row.appendChild(info);
    const up = alBtn("↑", t("Move up"), () => alMove(i, -1), "x");
    up.disabled = i === 0;
    const down = alBtn("↓", t("Move down"), () => alMove(i, 1), "x");
    down.disabled = i === A.sides.length - 1;
    const find = alBtn(t("find tracks"), t("Open this side in Tracks with the album's release"), () => alFind(i));
    find.disabled = !d || !!d.error;
    row.append(up, down, find, alBtn("×", t("Remove from the album"), () => alDrop(i), "x"));
    box.appendChild(row);
  });
  const docs = (ed.docs || []).filter(d => !A.sides.includes(d.id));
  const dd = $("albAdd");
  dd.innerHTML = '<div class="cur"></div><div class="list"></div>';
  dd.classList.toggle("hidden", !docs.length || A.sides.length >= 26);
  if (docs.length) ddInit(dd, [{ v: "", label: t("Add a side…") }].concat(docs.map(d => ({ v: d.id, label: d.name + " · " + fmtDur((d.len || d.frames) / d.sampleRate) }))), "", v => { if (v) alAdd(v); });
}

function alRenderTracks(A) {
  const box = $("albTracks"), letters = alLetters(A);
  box.textContent = "";
  let n = 0, total = 0, missing = 0;
  const extra = alRelSides(A).filter(x => x.k && !letters.includes(x.k));
  A.sides.concat(extra.map(() => null)).forEach((id, i) => {
    const tracks = id ? alSideTracks(A, i) : [], want = id ? alRelSide(A, i, letters[i]) || [] : extra[i - A.sides.length].tracks;
    const rows = tracks.map(x => ({ pos: x.pos, title: x.title, artist: x.artist, len: x.len, d: trDur((want.find(w => w.position === x.pos) || {}).duration), found: true }));
    for (const w of want) if (!tracks.some(x => x.pos === w.position)) rows.push({ pos: w.position, title: w.title, artist: w.artist, len: 0, d: trDur(w.duration), found: false });
    for (const r of rows) {
      const row = alEl("div", "albtrack" + (r.found ? "" : " miss"));
      row.append(alEl("span", "albpos", r.pos), alEl("span", "albtt", r.title + (r.artist ? " · " + r.artist : "")), alEl("span", "albln", r.found ? fmtDur(r.len) : t("not found")), alEl("span", "albdl", r.d ? fmtDur(r.d) : ""));
      box.appendChild(row);
      if (r.found) { n++; total += r.len; } else missing++;
    }
  });
  if (!box.childElementCount) box.appendChild(alEl("div", "snote", t("Find the tracks of each side, then export them all at once.")));
  return { n, total, missing };
}

function alRender() {
  const A = al.cur;
  if (!A) return;
  $("albName").value = A.title || "";
  $("albName").placeholder = alTitle(A);
  alRenderRel(A);
  alRenderHits();
  alRenderSides(A);
  const s = alRenderTracks(A);
  $("albSum").textContent = [A.sides.length === 1 ? t("1 side") : t("{n} sides").replace("{n}", A.sides.length), s.n === 1 ? t("1 track") : t("{n} tracks").replace("{n}", s.n), s.n ? fmtDur(s.total) : "", s.missing ? t("{n} not found").replace("{n}", s.missing) : ""].filter(Boolean).join(" · ");
  $("albExport").disabled = !s.n;
  alRenderCd(A);
  alRenderVn(A);
  alRenderSq(A);
}

async function alChanged() {
  await alSave();
  if (al.cur) { await alInfos(al.cur); alRender(); }
  alList();
}

async function alAdd(id) {
  const A = al.cur;
  if (!A || A.sides.includes(id)) return;
  const other = alOf(id);
  if (other && other.id !== A.id) { other.sides = other.sides.filter(x => x !== id); }
  A.sides.push(id);
  await alChanged();
}

async function alDrop(i) {
  const A = al.cur;
  if (!A) return;
  A.sides.splice(i, 1);
  await alChanged();
}

async function alMove(i, d) {
  const A = al.cur, j = i + d;
  if (!A || j < 0 || j >= A.sides.length) return;
  [A.sides[i], A.sides[j]] = [A.sides[j], A.sides[i]];
  await alChanged();
}

async function alRemove() {
  const A = al.cur;
  if (!A || !(await ask(t("Delete this album?"), t("Only the album goes. Its files stay in Studio with their tracks."), { ok: t("delete") }))) return;
  al.list = al.list.filter(a => a.id !== A.id);
  al.cur = null;
  await alSave();
  alHide();
  alList();
}

async function alSearch() {
  const q = $("albQ").value.trim();
  if (!q || al.busy) return;
  if (!(await trDiscogs()).connected && !(await trConnect())) return;
  al.busy = true;
  al.err = null;
  al.results = null;
  $("albSearch").disabled = true;
  try {
    const j = await trFetch("/api/locker/discogs/search?q=" + encodeURIComponent(q));
    const res = Array.isArray(j.results) ? j.results : [];
    if (res.length === 1 && Array.isArray(res[0].tracks)) { al.busy = false; await alUseRel(res[0]); }
    else al.results = res;
  } catch (e) {
    if (e.message !== "token") al.err = t("Discogs search failed") + ": " + e.message;
  } finally {
    al.busy = false;
    $("albSearch").disabled = false;
    alRenderHits();
  }
}

async function alPickRel(id) {
  if (al.busy) return;
  al.busy = true;
  try { const rel = await trFetch("/api/locker/discogs/release/" + encodeURIComponent(id)); al.busy = false; await alUseRel(rel); }
  catch (e) { if (e.message !== "token") { al.err = t("Discogs search failed") + ": " + e.message; alRenderHits(); } }
  finally { al.busy = false; }
}

async function alUseRel(rel) {
  const A = al.cur;
  if (!A || !rel) return;
  A.release = rel;
  al.results = null;
  await alChanged();
}

async function alGo(i) {
  const A = al.cur, id = A && A.sides[i];
  if (!id) return;
  alHide();
  if (!ed.doc || ed.doc.id !== id) await openDoc(id);
}

async function alFind(i) {
  const A = al.cur, id = A && A.sides[i];
  if (!id) return;
  const k = alLetters(A)[i], rel = A.release;
  alHide();
  if (!ed.doc || ed.doc.id !== id) await openDoc(id);
  if (!ed.doc || ed.doc.id !== id) return;
  if (rel) {
    trUse(rel);
    tr.want = k;
    const j = tr.opts.findIndex(o => o.v === k);
    if (j >= 0) { tr.side = j; trCompute(); }
  }
  openRepair("tr");
  trRender();
}

async function alExport() {
  const A = al.cur;
  if (!A) return;
  await alInfos(A);
  const letters = alLetters(A), sides = A.sides.map((id, i) => ({ info: al.infos[id], letter: letters[i], disc: Math.floor(i / 2) + 1 })).filter(s => s.info && !s.info.error);
  const ctx = { id: A.id, title: alTitle(A), named: !!A.title, artist: alArtist(A), genre: A.release ? A.release.genre : "", year: A.release && A.release.year ? String(A.release.year) : "", release: A.release, sides, ndisc: sides.length > 2 ? Math.ceil(sides.length / 2) : 1 };
  if (!sides.some(s => (s.info.marks || []).some(m => m.kind === "range"))) { tell(t("No side has tracks yet. Find the tracks of each side first.")); return; }
  const f = xpClean([ctx.artist, ctx.title].filter(Boolean).join(" - "));
  if (f) xp.cfg.folder = f;
  if (xp.cfg.tplRange === XP_DEFAULT.tplRange) xp.cfg.tplRange = "$position $title";
  xpSave();
  alHide();
  openExport(ctx);
}

function alList() {
  const box = $("albList");
  if (!box) return;
  box.textContent = "";
  if (!al.list.length) box.appendChild(alEl("div", "fempty", t("No albums yet. An album joins the sides of a record so they export as one.")));
  for (const A of al.list) {
    const row = alEl("div", "frow");
    const name = alEl("button", "fname");
    name.type = "button";
    name.append(alEl("span", "fn", A.title || (A.release && A.release.title) || t("Album")), alEl("span", "fi", [A.release && A.release.artist, A.sides.length === 1 ? t("1 side") : t("{n} sides").replace("{n}", A.sides.length), A.release ? "Discogs " + A.release.id : ""].filter(Boolean).join(" · ")));
    name.addEventListener("click", () => alOpen(A.id));
    row.appendChild(name);
    box.appendChild(row);
  }
}

async function alTab() {
  await alLoad();
  if (!ed.docs) { try { ed.docs = (await call({ t: "list" })).docs; } catch {} }
  alList();
}

function wireAlbum() {
  $("albClose").addEventListener("click", alHide);
  $("alb").addEventListener("pointerdown", e => { if (e.target === $("alb")) alHide(); });
  $("alb").addEventListener("keydown", e => {
    if (e.key === "Escape" && !e.target.closest(".dd.open")) { e.stopPropagation(); alHide(); }
    else if (e.key === "Enter" && e.target.id === "albQ") { e.preventDefault(); alSearch(); }
  });
  $("albName").addEventListener("change", async () => { if (!al.cur) return; al.cur.title = $("albName").value.trim(); await alChanged(); });
  $("albSearch").addEventListener("click", alSearch);
  $("albRelClear").addEventListener("click", async () => { if (!al.cur) return; al.cur.release = null; await alChanged(); });
  $("albDel").addEventListener("click", alRemove);
  $("albExport").addEventListener("click", alExport);
  $("albNew").addEventListener("click", alNew);
  $("trAlb").addEventListener("click", () => { if (ed.doc) alOpenFor(ed.doc.id); });
  alLoad();
}

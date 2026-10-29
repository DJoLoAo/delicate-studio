const ci = { files: [], heads: [], toc: null, from: "", ids: null, mb: null, rels: [], pick: 0, ar: null, arState: "", edit: null, doc: null, ver: null, album: "", busy: false, note: "" };

function ciPlistValue(el) {
  const kids = [...el.children];
  switch (el.tagName) {
    case "dict": { const o = {}; for (let i = 0; i + 1 < kids.length; i += 2) o[kids[i].textContent] = ciPlistValue(kids[i + 1]); return o; }
    case "array": return kids.map(ciPlistValue);
    case "integer": return parseInt(el.textContent, 10);
    case "real": return parseFloat(el.textContent);
    case "true": return true;
    case "false": return false;
    default: return el.textContent;
  }
}

function ciPlist(text) {
  try {
    const d = new DOMParser().parseFromString(text, "application/xml"), root = d.querySelector("plist > dict");
    if (!root) return null;
    const v = ciPlistValue(root), S = Array.isArray(v.Sessions) ? v.Sessions : [];
    const sessions = S.map(s => ({ n: s["Session Number"] || 1, leadout: s["Leadout Block"], tracks: (s["Track Array"] || []).map(k => ({ point: k.Point, start: k["Start Block"], data: !!k.Data })) })).filter(s => Number.isInteger(s.leadout) && s.tracks.every(k => Number.isInteger(k.start)));
    return sessions.length ? sessions : null;
  } catch { return null; }
}

function ciNum(name) { const m = /^\s*(\d+)/.exec(name); return m ? parseInt(m[1], 10) : 1e9; }

function ciTitleOf(name) {
  const t0 = name.replace(/\.aiff?$/i, "").replace(/^\s*\d+[\s._-]*/, "").trim();
  return /^audio track$/i.test(t0) ? "" : t0;
}

function ciOpen() {
  closeFiles();
  closePopovers();
  $("cdi").classList.remove("hidden");
  ciRender();
}

function ciClose() { $("cdi").classList.add("hidden"); }

function ciReset() {
  Object.assign(ci, { files: [], heads: [], toc: null, from: "", ids: null, mb: null, rels: [], pick: 0, ar: null, arState: "", edit: null, doc: null, ver: null, album: "", note: "" });
}

async function ciPickDir() {
  if (!window.showDirectoryPicker) { $("ciDir").click(); return; }
  let dir;
  try { dir = await window.showDirectoryPicker({ id: "studio-cd", mode: "read" }); } catch { return; }
  const files = [];
  try { for await (const h of dir.values()) if (h.kind === "file") files.push(await h.getFile()); } catch (e) { tell(String(e.message || e), t("Could not read the CD")); return; }
  ciUse(files);
}

async function ciUse(list) {
  const all = [...list].filter(Boolean);
  const aiff = all.filter(f => /\.aiff?$/i.test(f.name) && !f.name.startsWith(".")).sort((a, b) => ciNum(a.name) - ciNum(b.name) || a.name.localeCompare(b.name));
  const plistF = all.find(f => f.name === ".TOC.plist");
  ciReset();
  if (!aiff.length) {
    ci.note = all.some(f => /\.cda$/i.test(f.name)) ? t("These are .cda shortcuts, not audio: Windows does not show the tracks as files. Ripping there needs the Delicate Bridge, which is on its way.") : t("No AIFF tracks here. On a Mac, insert the CD and choose it in the Finder sidebar.");
    ciRender();
    return;
  }
  const heads = [];
  for (const f of aiff) {
    const h = ciAiff(new Uint8Array(await f.slice(0, Math.min(f.size, 1 << 16)).arrayBuffer()));
    if (!h || h.bad || h.ch !== 2 || h.bits !== 16 || h.sr !== 44100) { ci.note = t("{f} is not CD audio (AIFF, 16-bit, 44.1 kHz, stereo).").replace("{f}", f.name); ciRender(); return; }
    heads.push(h);
  }
  ci.files = aiff;
  ci.heads = heads;
  const whole = heads.every(h => h.frames % CI_SPF === 0), lens = heads.map(h => Math.round(h.frames / CI_SPF));
  const sessions = plistF ? ciPlist(await plistF.text()) : null;
  let toc = sessions ? ciTocPlist(sessions) : null, from = toc ? "disc" : "";
  if (toc && (toc.lens.length !== lens.length || toc.lens.some((v, i) => Math.abs(v - lens[i]) > 1))) { toc = null; from = ""; }
  if (!toc && whole) { toc = ciToc(lens, 0, 0); from = "lengths"; }
  ci.toc = toc;
  ci.from = from;
  ci.edit = { title: "", artist: "", year: "", label: "", catno: "", barcode: "", tracks: aiff.map(f => ({ title: ciTitleOf(f.name), artist: "", isrc: "" })) };
  if (!toc) { ci.note = t("The track lengths are not whole CD sectors: this is not a straight CD rip, so it cannot be looked up or verified."); ciRender(); return; }
  ci.ids = { mb: await ciMbId(toc), ar: ciArName(toc), freedb: ciHex(ciFreedb(toc)) };
  ciRender();
  await Promise.all([ciLookupMb(), ciLookupAr()]);
  ciRender();
}

async function ciLookupMb() {
  ci.mb = "loading";
  ciRender();
  try {
    const r = await fetch("/api/studio/cd/mb/" + encodeURIComponent(ci.ids.mb) + "?toc=" + encodeURIComponent(ciMbToc(ci.toc)), { cache: "no-store" });
    if (r.status === 404) { ci.mb = "none"; return; }
    if (!r.ok) { ci.mb = r.status === 401 ? "login" : "error"; return; }
    const j = await r.json(), rels = Array.isArray(j.releases) ? j.releases : j.id && j.media ? [j] : [];
    ci.rels = rels.map(rel => ciRelease(rel)).filter(Boolean);
    ci.mb = ci.rels.length ? "ok" : "none";
    if (ci.rels.length) ciApply(0);
  } catch { ci.mb = "error"; }
}

function ciCredit(ac) { return (Array.isArray(ac) ? ac : []).map(x => (x.name || (x.artist && x.artist.name) || "") + (x.joinphrase || "")).join("").trim(); }

function ciRelease(rel) {
  const n = ci.files.length, media = Array.isArray(rel.media) ? rel.media : [];
  const med = media.find(m => (m.discs || []).some(d => d.id === ci.ids.mb)) || media.find(m => (m.tracks || []).length === n);
  if (!med) return null;
  const li = (rel["label-info"] || [])[0] || {}, artist = ciCredit(rel["artist-credit"]);
  return {
    id: rel.id, title: rel.title || "", artist, year: String(rel.date || "").slice(0, 4), country: rel.country || "", label: (li.label && li.label.name) || "", catno: li["catalog-number"] || "", barcode: String(rel.barcode || "").replace(/\D/g, ""),
    disc: med.position || 1, discs: media.length,
    tracks: (med.tracks || []).map(k => ({ title: k.title || (k.recording && k.recording.title) || "", artist: ciCredit(k["artist-credit"]) || artist, isrc: ((k.recording && k.recording.isrcs) || [])[0] || "" }))
  };
}

function ciApply(i) {
  const R = ci.rels[i];
  if (!R) return;
  ci.pick = i;
  ci.edit = { title: R.title + (R.discs > 1 ? " (" + t("disc {n}").replace("{n}", R.disc) + ")" : ""), artist: R.artist, year: R.year, label: R.label, catno: R.catno, barcode: R.barcode, mbid: R.id, tracks: ci.files.map((f, k) => { const x = R.tracks[k] || {}; return { title: x.title || ciTitleOf(f.name), artist: x.artist && x.artist !== R.artist ? x.artist : "", isrc: x.isrc || "" }; }) };
}

async function ciLookupAr() {
  ci.arState = "loading";
  try {
    const r = await fetch("/api/studio/cd/ar/" + ci.ids.ar, { cache: "no-store" });
    if (r.status === 404) { ci.arState = "none"; ci.ar = []; return; }
    if (!r.ok) { ci.arState = "error"; return; }
    ci.ar = ciDbar(await r.arrayBuffer()).filter(p => p.n === ci.files.length);
    ci.arState = ci.ar.length ? "ok" : "none";
  } catch { ci.arState = "error"; }
}

function ciFrames() { const out = []; let at = 0; for (const h of ci.heads) { out.push([at, at + h.frames]); at += h.frames; } return out; }

async function ciImport() {
  if (ci.busy || !ci.files.length || ci.doc) return;
  ci.busy = true;
  ciRender();
  const E = ci.edit, T = ciFrames(), name = [E.artist, E.title].filter(Boolean).join(" - ") || t("Audio CD");
  const marks = T.map((r, i) => { const k = E.tracks[i] || {}; return { a: r[0], b: r[1], name: k.title || t("Track {n}").replace("{n}", i + 1), tag: { pos: String(i + 1), title: k.title || "", artist: k.artist || E.artist || "", isrc: k.isrc || "", album: E.title || "", albumArtist: E.artist || "", year: E.year || "", label: E.label || "", catno: E.catno || "" } }; });
  const tags = [["ALBUM", E.title], ["ALBUMARTIST", E.artist], ["ARTIST", E.artist], ["DATE", E.year], ["LABEL", E.label], ["CATALOGNUMBER", E.catno], ["BARCODE", E.barcode], ["MUSICBRAINZ_DISCID", ci.ids && ci.ids.mb]].filter(x => x[1]);
  const cdMeta = ci.ids ? { mb: ci.ids.mb, ar: ci.ids.ar, freedb: ci.ids.freedb, toc: { offsets: ci.toc.offsets, end: ci.toc.end, leadout: ci.toc.leadout }, release: E.mbid || "", from: ci.from } : null;
  try {
    ed.importing = { name, frac: 0 };
    importProgress({ name, frac: 0 });
    let meta = (await call({ t: "cdimport", name, files: ci.files, marks, tags, cd: cdMeta, source: { kind: "cd" } })).meta;
    if (ci.toc) {
      importProgress({ name, frac: 0, phase: "verify" });
      const v = await call({ t: "cdverify", id: meta.id, name, tracks: T, ar: ci.ar || [] });
      const best = v.results[0];
      ci.ver = { crcs: v.crcs, best, ok: best.tracks.filter(x => x.conf > 0).length, known: best.tracks.some(x => x.total > 0) };
      if (best.offset && ci.ver.ok) {
        const sh = (await call({ t: "cdshift", id: meta.id, name, shift: best.offset })).meta;
        try { await call({ t: "remove", id: meta.id }); } catch {}
        meta = sh;
      }
    }
    ci.doc = meta.id;
    const A = { id: "", title: E.title || name, release: null, sides: [meta.id], created: Date.now(), cd: { upc: cdUpcOk(E.barcode || "") ? E.barcode : "", title: E.title || "", performer: E.artist || "" } };
    al.list.push(A);
    await alSave();
    ci.album = (al.list[al.list.length - 1] || {}).id || "";
    refreshFiles();
    call({ t: "persist" }).catch(() => {});
  } catch (e) {
    if ((e && e.message) !== "cancelled") tell(String((e && e.message) || e), t("Could not import the CD"));
  } finally {
    ed.importing = null;
    $("busy").classList.add("hidden");
    ci.busy = false;
    ciRender();
  }
}

async function ciOpenAlbum() {
  if (!ci.album) return;
  ciClose();
  await alOpen(ci.album);
  try { if ((await trDiscogs()).connected) alSearch(); } catch {}
}

async function ciOpenDoc() {
  if (!ci.doc) return;
  ciClose();
  await openDoc(ci.doc);
}

function ciArText(i) {
  const V = ci.ver;
  if (!V) return "";
  const x = V.best.tracks[i];
  if (!x) return "";
  if (x.conf > 0) return "✓ " + t("accurate ({c} of {n})").replace("{c}", x.conf).replace("{n}", x.total);
  if (x.total > 0) return "✗ " + t("no match");
  return "—";
}

function ciSummary() {
  const V = ci.ver, n = ci.files.length;
  if (!V) return ci.arState === "none" ? { good: false, soft: true, text: t("This pressing is not in AccurateRip yet, so the rip cannot be compared with others.") } : ci.arState === "ok" ? { good: true, text: t("Found in AccurateRip: {p} pressings to compare with.").replace("{p}", ci.ar.length) } : ci.arState === "error" ? { good: false, soft: true, text: t("AccurateRip could not be reached.") } : null;
  const off = V.best.offset ? " " + t("Read offset {o} samples corrected.").replace("{o}", (V.best.offset > 0 ? "+" : "") + V.best.offset) : "";
  if (!V.known) return { good: false, soft: true, text: t("This pressing is not in AccurateRip yet, so the rip cannot be compared with others.") };
  if (V.ok === n) return { good: true, text: t("All {n} tracks accurately ripped.").replace("{n}", n) + off };
  const badT = V.best.tracks.map((x, i) => x.total > 0 && !x.conf ? i + 1 : 0).filter(Boolean);
  return { good: false, text: t("{k} of {n} tracks accurate. Clean the disc and rip {t} again.").replace("{k}", V.ok).replace("{n}", n).replace("{t}", badT.join(", ")) + off };
}

function ciRender() {
  const box = $("ciBody");
  if (!box) return;
  box.textContent = "";
  const sec = (title) => { const s = alEl("section", ""); if (title) s.appendChild(alEl("h3", "", t(title))); box.appendChild(s); return s; };
  const src = sec("");
  src.appendChild(alEl("div", "snote", t("On a Mac, insert the CD and choose it: macOS shows each track as an AIFF file. Choose the CD itself, so its hidden table of contents comes along.")));
  const row = alEl("div", "row");
  const pick = alBtn(t("Choose the CD"), t("The CD as it appears in the Finder"), () => ciPickDir(), "outbtn ciDirBtn");
  const pickF = alBtn(t("Choose the tracks"), t("The AIFF tracks, and .TOC.plist if you can see it"), () => $("ciFiles").click(), "outbtn ciFilesBtn");
  pick.disabled = pickF.disabled = ci.busy || !!ci.doc;
  row.append(pick, pickF);
  src.appendChild(row);
  if (ci.note) src.appendChild(alEl("div", "cinote", ci.note));
  if (!ci.files.length) return;
  const disc = sec("Disc");
  const len = ci.heads.reduce((a, h) => a + h.frames, 0) / 44100;
  disc.appendChild(alEl("div", "ciinfo", [t("{n} tracks").replace("{n}", ci.files.length), fmtDur(len), ci.from === "disc" ? t("table of contents from the disc") : ci.from === "lengths" ? t("table of contents worked out from the track lengths") : ""].filter(Boolean).join(" · ")));
  if (ci.ids) disc.appendChild(alEl("div", "ciids", "MusicBrainz " + ci.ids.mb + " · AccurateRip " + ci.ids.ar.slice(5, -4) + " · FreeDB " + ci.ids.freedb));
  if (ci.from === "lengths") disc.appendChild(alEl("div", "snote", t("Without the hidden table of contents a hidden first track or a data track is missed and the disc is not found.")));
  const rel = sec("Release");
  if (ci.mb === "loading") rel.appendChild(alEl("div", "snote", t("Looking the disc up on MusicBrainz…")));
  else if (ci.mb === "none") rel.appendChild(alEl("div", "snote", t("Not found on MusicBrainz. Name the album and the tracks yourself.")));
  else if (ci.mb === "error") rel.appendChild(alEl("div", "snote", t("MusicBrainz could not be reached. Name the album and the tracks yourself.")));
  else if (ci.mb === "login") rel.appendChild(alEl("div", "snote", t("Sign in to look the disc up.")));
  if (ci.rels.length > 1) {
    const dd = alEl("div", "dd down cirel");
    dd.innerHTML = '<div class="cur"></div><div class="list"></div>';
    ddInit(dd, ci.rels.map((R, i) => ({ v: String(i), label: [R.artist, R.title].filter(Boolean).join(" – ") + " · " + [R.year, R.country, R.label, R.catno].filter(Boolean).join(" · ") })), String(ci.pick), v => { ciApply(Number(v)); ciRender(); });
    rel.appendChild(dd);
  }
  const E = ci.edit, lock = ci.busy || !!ci.doc;
  const head = alEl("div", "cdhead dxhead");
  const inp = (cls, v, ph, f) => { const i = cdInput(cls, v, ph, x => { E[f] = x.trim(); }); i.disabled = lock; return i; };
  head.append(alEl("label", "", t("Album")), inp("ciTitle", E.title, t("Album title"), "title"), alEl("label", "", t("Artist")), inp("ciArtist", E.artist, t("Artist"), "artist"),
    alEl("label", "", t("Year")), inp("ciYear", E.year, "", "year"), alEl("label", "", "UPC/EAN"), inp("ciUpc", E.barcode, "", "barcode"));
  rel.appendChild(head);
  const tbl = alEl("div", "citbl");
  tbl.append(alEl("span", "cdh", "#"), alEl("span", "cdh", t("Length")), alEl("span", "cdh", t("Title")), alEl("span", "cdh", t("Artist")), alEl("span", "cdh", "ISRC"), alEl("span", "cdh", "AccurateRip"));
  ci.heads.forEach((h, i) => {
    const k = E.tracks[i], ti = cdInput("ciT", k.title, t("Track {n}").replace("{n}", i + 1), x => { k.title = x.trim(); }), ta = cdInput("ciA", k.artist, E.artist, x => { k.artist = x.trim(); }), tc = cdInput("ciI", k.isrc, "CCXXXYYNNNNN", x => { k.isrc = x.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    ti.disabled = ta.disabled = tc.disabled = lock;
    const ar = ciArText(i);
    tbl.append(alEl("span", "cdn", String(i + 1)), alEl("span", "cdtm", fmtDur(h.frames / 44100)), ti, ta, tc, alEl("span", "ciar" + (ar.startsWith("✓") ? " ok" : ar.startsWith("✗") ? " bad" : ""), ar));
  });
  rel.appendChild(tbl);
  const chk = alEl("div", "cdchk");
  const sm = ciSummary();
  if (sm) chk.appendChild(alEl("div", sm.good ? "ok" : "bad", (sm.good ? "✓ " : "⚠ ") + sm.text));
  if (!ci.doc) chk.appendChild(alEl("div", "ok", "ℹ " + t("macOS reads the disc once, without re-reading bad spots. AccurateRip tells whether the rip matches everyone else's.")));
  rel.appendChild(chk);
  const btns = alEl("div", "cdbtns");
  if (!ci.doc) {
    const go = alBtn(t("Import and verify"), t("Reads every track into one Studio file with the tracks as range markers, checks it against AccurateRip and makes an album"), () => ciImport(), "outbtn cigo");
    go.disabled = ci.busy || ci.mb === "loading" || ci.arState === "loading";
    btns.appendChild(go);
  } else {
    btns.append(alBtn(t("Open the album"), t("The album with this CD as its side, for Discogs, the CD section and the exports"), () => ciOpenAlbum(), "outbtn cialbum"), alBtn(t("Open the file"), t("Open the rip in the waveform"), () => ciOpenDoc(), "outbtn cidoc"), alBtn(t("Import another CD"), "", () => { ciReset(); ciRender(); }, "outbtn ciagain"));
  }
  rel.appendChild(btns);
}

function ciInit() {
  $("ciClose").addEventListener("click", ciClose);
  $("ciFiles").addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) ciUse(f); });
  $("ciDir").addEventListener("change", e => { const f = [...e.target.files]; e.target.value = ""; if (f.length) ciUse(f); });
  $("cdi").addEventListener("click", e => { if (e.target.id === "cdi") ciClose(); });
  $("cdi").addEventListener("dragover", e => { e.preventDefault(); e.stopPropagation(); });
  $("cdi").addEventListener("drop", e => { e.preventDefault(); e.stopPropagation(); if (!ci.busy && !ci.doc && e.dataTransfer && e.dataTransfer.files.length) ciUse([...e.dataTransfer.files]); });
  $("ciOpen").addEventListener("click", ciOpen);
}

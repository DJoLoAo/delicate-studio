const ci = { src: "", n: 0, files: [], heads: [], toc: null, from: "", ids: null, mb: null, rels: [], pick: 0, ar: null, arState: "", edit: null, doc: null, ver: null, album: "", busy: false, note: "", disc: null, cdtext: null, htoa: 0, drive: 0, drives: [], doff: null, report: null, shift: 0, shiftBy: "" };

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
  if (brToken()) brConnect().then(s => { if (s === "on" && !ci.drives.length) ciDrives(); });
}

function ciClose() { $("cdi").classList.add("hidden"); }

function ciReset() {
  Object.assign(ci, { src: "", n: 0, files: [], heads: [], toc: null, from: "", ids: null, mb: null, rels: [], pick: 0, ar: null, arState: "", edit: null, doc: null, ver: null, album: "", note: "", disc: null, cdtext: null, htoa: 0, doff: null, report: null, shift: 0, shiftBy: "" });
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
  ci.src = "files";
  ci.files = aiff;
  ci.heads = heads;
  ci.n = heads.length;
  const whole = heads.every(h => h.frames % CI_SPF === 0), lens = heads.map(h => Math.round(h.frames / CI_SPF));
  const sessions = plistF ? ciPlist(await plistF.text()) : null;
  let toc = sessions ? ciTocPlist(sessions) : null, from = toc ? "disc" : "";
  if (toc && (toc.lens.length !== lens.length || toc.lens.some((v, i) => Math.abs(v - lens[i]) > 1))) { toc = null; from = ""; }
  if (!toc && whole) { toc = ciToc(lens, 0, 0); from = "lengths"; }
  ci.toc = toc;
  ci.from = from;
  ci.edit = { title: "", artist: "", year: "", label: "", catno: "", barcode: "", tracks: aiff.map(f => ({ title: ciTitleOf(f.name), artist: "", isrc: "" })) };
  if (!toc) { ci.note = t("The track lengths are not whole CD sectors: this is not a straight CD rip, so it cannot be looked up or verified."); ciRender(); return; }
  await ciLookups();
}

async function ciLookups() {
  ci.ids = { mb: await ciMbId(ci.toc), ar: ciArName(ci.toc), freedb: ciHex(ciFreedb(ci.toc)) };
  ciRender();
  await Promise.all([ciLookupMb(), ciLookupAr(), ci.src === "bridge" ? ciLookupOffset() : null]);
  ciRender();
}

async function ciDrives() {
  try {
    const r = await brCall("drives", {}, 30000);
    ci.drives = (r && r.drives) || [];
    if (ci.drive >= ci.drives.length) ci.drive = 0;
  } catch { ci.drives = []; }
  ciRender();
}

function ciHexBytes(h) { const b = new Uint8Array(h.length >> 1); for (let i = 0; i < b.length; i++) b[i] = parseInt(h.substr(i * 2, 2), 16); return b; }

async function ciReadDisc() {
  if (ci.busy) return;
  ci.busy = true;
  ciRender();
  let info = null;
  try { info = await brCall("disc", { drive: ci.drive }, 180000); } catch (e) { info = { error: e.message }; }
  ci.busy = false;
  ciReset();
  if (!info || !info.ok) { ci.note = t("The Delicate Bridge could not read the disc") + (info && info.error ? ": " + info.error : "."); ciRender(); return; }
  const toc = ciTocFrom(info);
  if (!toc) { ci.note = t("This disc has no audio tracks."); ciRender(); return; }
  ci.src = "bridge";
  ci.disc = info;
  ci.toc = toc;
  ci.from = "drive";
  ci.n = toc.lens.length;
  ci.heads = toc.lens.map(l => ({ frames: l * CI_SPF }));
  ci.htoa = info.htoa && info.htoa.peak > 64 ? info.htoa.sectors : 0;
  ci.cdtext = info.cdtext ? ciCdText(ciHexBytes(info.cdtext)) : null;
  const ct = ci.cdtext || { title: "", performer: "", tracks: [] };
  ci.edit = { title: ct.title, artist: ct.performer, year: "", label: "", catno: "", barcode: /^\d{12,13}$/.test(info.mcn || "") ? info.mcn : "", tracks: toc.lens.map((l, i) => { const x = ct.tracks[i] || {}; return { title: x.title || "", artist: x.performer && x.performer !== ct.performer ? x.performer : "", isrc: (info.isrc || [])[i] || "" }; }) };
  await ciLookups();
}

async function ciLookupOffset() {
  try {
    if (!br.offsets) {
      const r = await fetch("/api/studio/cd/offsets", { cache: "no-store" });
      br.offsets = r.ok ? ciOffsets(await r.arrayBuffer()) : [];
    }
    const hit = ciDriveOffset(br.offsets, ci.disc && ci.disc.name);
    ci.doff = hit ? { offset: hit.offset, name: hit.name } : { offset: null, name: "" };
  } catch { ci.doff = { offset: null, name: "" }; }
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
  const n = ci.n, media = Array.isArray(rel.media) ? rel.media : [];
  const med = media.find(m => (m.discs || []).some(d => d.id === ci.ids.mb)) || media.find(m => (m.tracks || []).length === n);
  if (!med) return null;
  const li = (rel["label-info"] || [])[0] || {}, artist = ciCredit(rel["artist-credit"]);
  return {
    id: rel.id, title: rel.title || "", artist, year: String(rel.date || "").slice(0, 4), country: rel.country || "", label: (li.label && li.label.name) || "", catno: li["catalog-number"] || "", barcode: String(rel.barcode || "").replace(/\D/g, ""),
    disc: med.position || 1, discs: media.length,
    tracks: (med.tracks || []).map(k => ({ title: k.title || (k.recording && k.recording.title) || "", artist: ciCredit(k["artist-credit"]) || artist, isrc: ((k.recording && k.recording.isrcs) || [])[0] || "" }))
  };
}

function ciFallback(k) {
  if (ci.src === "files") return { title: ciTitleOf(ci.files[k].name), artist: "", isrc: "" };
  const ct = (ci.cdtext && ci.cdtext.tracks[k]) || {};
  return { title: ct.title || "", artist: "", isrc: (ci.disc && (ci.disc.isrc || [])[k]) || "" };
}

function ciApply(i) {
  const R = ci.rels[i];
  if (!R) return;
  ci.pick = i;
  const mcn = ci.disc && /^\d{12,13}$/.test(ci.disc.mcn || "") ? ci.disc.mcn : "";
  ci.edit = { title: R.title + (R.discs > 1 ? " (" + t("disc {n}").replace("{n}", R.disc) + ")" : ""), artist: R.artist, year: R.year, label: R.label, catno: R.catno, barcode: R.barcode || mcn, mbid: R.id, tracks: Array.from({ length: ci.n }, (_, k) => { const x = R.tracks[k] || {}, f = ciFallback(k); return { title: x.title || f.title, artist: x.artist && x.artist !== R.artist ? x.artist : "", isrc: f.isrc || x.isrc || "" }; }) };
}

async function ciLookupAr() {
  ci.arState = "loading";
  try {
    const r = await fetch("/api/studio/cd/ar/" + ci.ids.ar, { cache: "no-store" });
    if (r.status === 404) { ci.arState = "none"; ci.ar = []; return; }
    if (!r.ok) { ci.arState = "error"; return; }
    ci.ar = ciDbar(await r.arrayBuffer()).filter(p => p.n === ci.n);
    ci.arState = ci.ar.length ? "ok" : "none";
  } catch { ci.arState = "error"; }
}

function ciHtoaFrames() { return ci.htoa * CI_SPF; }

function ciFrames() { const out = []; let at = ciHtoaFrames(); for (const h of ci.heads) { out.push([at, at + h.frames]); at += h.frames; } return out; }

function ciMarks(E, T) {
  const tag = (k, pos) => ({ pos, title: k.title || "", artist: k.artist || E.artist || "", isrc: k.isrc || "", album: E.title || "", albumArtist: E.artist || "", year: E.year || "", label: E.label || "", catno: E.catno || "" });
  const out = T.map((r, i) => { const k = E.tracks[i] || {}; return { a: r[0], b: r[1], name: k.title || t("Track {n}").replace("{n}", i + 1), tag: tag(k, String(i + 1)) }; });
  if (ci.htoa) out.unshift({ a: 0, b: ciHtoaFrames(), name: t("Hidden track"), tag: tag({ title: t("Hidden track") }, "0") });
  return out;
}

async function ciRip(name, marks, tags, cdMeta) {
  const D = ci.disc, first = D.toc.tracks.find(x => !x.data).lba, from = ci.htoa ? 0 : first, to = first + ci.toc.lens.reduce((a, b) => a + b, 0);
  const total = (to - from) * CI_SPF, b = await call({ t: "cdbegin", name, frames: total, marks, tags, cd: cdMeta, source: { kind: "cd", via: "bridge" } });
  const job = (Date.now() % 1e9) + 1;
  let got = 0;
  br.job = job;
  br.onbin = buf => {
    const dv = new DataView(buf);
    if (dv.getUint32(0, true) !== job) return;
    got += dv.getUint32(8, true) * CI_SPF;
    const pcm = buf.slice(12);
    ed.worker.postMessage({ t: "cdchunk", wid: b.wid, bytes: pcm }, [pcm]);
    importProgress({ name, frac: got / total, phase: "rip" });
  };
  let r;
  try { r = await brCall("rip", { drive: ci.drive, job, from, to, end: D.toc.leadout }); }
  finally { br.onbin = null; br.job = 0; }
  if (!r.ok || got < total) { await call({ t: "cdabort", wid: b.wid }).catch(() => {}); throw new Error(r.cancelled ? "cancelled" : r.error || t("The rip stopped early.")); }
  ci.report = Object.assign({ from }, r.report || {});
  return (await call({ t: "cdend", wid: b.wid, cd: { report: { rereads: r.report.rereads, fixed: r.report.fixed.length, suspect: r.report.suspect, c2: r.report.c2 } } })).meta;
}

async function ciImport() {
  if (ci.busy || !ci.n || ci.doc) return;
  if (ci.src === "bridge" && br.state !== "on") { tell(t("The Delicate Bridge is not connected any more."), t("Could not rip the CD")); return; }
  ci.busy = true;
  ciRender();
  const E = ci.edit, T = ciFrames(), name = [E.artist, E.title].filter(Boolean).join(" - ") || t("Audio CD"), marks = ciMarks(E, T);
  const tags = [["ALBUM", E.title], ["ALBUMARTIST", E.artist], ["ARTIST", E.artist], ["DATE", E.year], ["LABEL", E.label], ["CATALOGNUMBER", E.catno], ["BARCODE", E.barcode], ["MUSICBRAINZ_DISCID", ci.ids && ci.ids.mb]].filter(x => x[1]);
  const cdMeta = ci.ids ? { mb: ci.ids.mb, ar: ci.ids.ar, freedb: ci.ids.freedb, toc: { offsets: ci.toc.offsets, end: ci.toc.end, leadout: ci.toc.leadout }, release: E.mbid || "", from: ci.from, htoa: ci.htoa, index0: ci.disc ? ci.disc.pregaps : [], drive: ci.disc ? ci.disc.name : "" } : null;
  try {
    ed.importing = { name, frac: 0 };
    importProgress({ name, frac: 0, phase: ci.src === "bridge" ? "rip" : "" });
    let meta = ci.src === "bridge" ? await ciRip(name, marks, tags, cdMeta) : (await call({ t: "cdimport", name, files: ci.files, marks, tags, cd: cdMeta, source: { kind: "cd" } })).meta;
    if (ci.toc) {
      importProgress({ name, frac: 0, phase: "verify" });
      const v = await call({ t: "cdverify", id: meta.id, name, tracks: T, ar: ci.ar || [] });
      const best = v.results[0];
      ci.ver = { crcs: v.crcs, best, ok: best.tracks.filter(x => x.conf > 0).length, known: best.tracks.some(x => x.total > 0) };
      let shift = 0;
      if (ci.ver.ok) { shift = best.offset; ci.shiftBy = "ar"; }
      else if (ci.doff && Number.isInteger(ci.doff.offset)) { shift = ci.doff.offset; ci.shiftBy = "drive"; }
      ci.shift = shift;
      if (shift) {
        const sh = (await call({ t: "cdshift", id: meta.id, name, shift })).meta;
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
    if ((e && e.message) !== "cancelled") tell(String((e && e.message) || e), t(ci.src === "bridge" ? "Could not rip the CD" : "Could not import the CD"));
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

function ciTrackLbas(i) {
  const a = ci.toc.offsets[i] - CI_LEAD;
  return [a, a + ci.toc.lens[i]];
}

function ciReadText(i) {
  const R = ci.report;
  if (!R) return "";
  const [a, b] = ciTrackLbas(i), sus = R.suspect.filter(l => l >= a && l < b).length, fix = R.fixed.filter(l => l >= a && l < b).length;
  if (sus) return "⚠ " + t("{n} suspect").replace("{n}", sus);
  if (fix) return "✓ " + t("{n} re-read").replace("{n}", fix);
  return "✓ " + t("secure");
}

function ciSummary() {
  const V = ci.ver, n = ci.n;
  if (!V) return ci.arState === "none" ? { good: false, soft: true, text: t("This pressing is not in AccurateRip yet, so the rip cannot be compared with others.") } : ci.arState === "ok" ? { good: true, text: t("Found in AccurateRip: {p} pressings to compare with.").replace("{p}", ci.ar.length) } : ci.arState === "error" ? { good: false, soft: true, text: t("AccurateRip could not be reached.") } : null;
  const o = (ci.shift > 0 ? "+" : "") + ci.shift;
  const off = !ci.shift ? "" : " " + (ci.shiftBy === "drive" ? t("Drive read offset {o} samples corrected (AccurateRip drive list).") : t("Read offset {o} samples corrected.")).replace("{o}", o);
  if (!V.known) return { good: false, soft: true, text: t("This pressing is not in AccurateRip yet, so the rip cannot be compared with others.") + off };
  if (V.ok === n) return { good: true, text: t("All {n} tracks accurately ripped.").replace("{n}", n) + off };
  const badT = V.best.tracks.map((x, i) => x.total > 0 && !x.conf ? i + 1 : 0).filter(Boolean);
  return { good: false, text: t("{k} of {n} tracks accurate. Clean the disc and rip {t} again.").replace("{k}", V.ok).replace("{n}", n).replace("{t}", badT.join(", ")) + off };
}

function ciBridgeBox(box) {
  const s = alEl("section", "cibr");
  s.appendChild(alEl("h3", "", "Delicate Bridge"));
  const row = alEl("div", "row");
  const lock = ci.busy || !!ci.doc;
  if (br.state === "on") {
    if (!ci.drives.length) {
      s.appendChild(alEl("div", "snote", t("No CD drive found. Connect the drive and insert a disc.")));
      row.appendChild(alBtn(t("Look again"), "", () => ciDrives(), "outbtn cibrscan"));
    } else {
      if (ci.drives.length > 1) {
        const dd = alEl("div", "dd down cidrive");
        dd.innerHTML = '<div class="cur"></div><div class="list"></div>';
        ddInit(dd, ci.drives.map(d => ({ v: String(d.i), label: d.name })), String(ci.drive), v => { ci.drive = Number(v); });
        row.appendChild(dd);
      } else row.appendChild(alEl("span", "ciinfo", ci.drives[0].name));
      const rd = alBtn(t("Read the disc"), t("Table of contents, pregaps, hidden track, ISRC, MCN and CD-Text from the disc"), () => ciReadDisc(), "outbtn cibrread");
      rd.disabled = lock;
      row.appendChild(rd);
    }
    s.appendChild(alEl("div", "snote", t("Secure rip: every sector is read twice and re-read until two reads agree, with C2 error pointers where the drive has them.")));
  } else if (br.state === "pair") {
    s.appendChild(alEl("div", "snote", t("The Delicate Bridge is running. Pair it once with this browser.")));
    row.appendChild(alBtn(t("Pair"), "", () => brPair().then(ok => { if (ok) ciDrives(); }), "outbtn cibrpair"));
  } else {
    s.appendChild(alEl("div", "snote", t("For a secure rip, start the Delicate Bridge on your Mac. It reads the drive directly: re-reads, drive offset, pregaps, hidden first track, ISRC and CD-Text.")));
    row.appendChild(alBtn(t("Connect"), "", () => brConnect().then(s2 => { if (s2 === "on") ciDrives(); }), "outbtn cibrcon"));
  }
  s.appendChild(row);
  box.appendChild(s);
}

function ciRender() {
  const box = $("ciBody");
  if (!box) return;
  box.textContent = "";
  const sec = (title) => { const s = alEl("section", ""); if (title) s.appendChild(alEl("h3", "", t(title))); box.appendChild(s); return s; };
  ciBridgeBox(box);
  const src = sec("");
  src.appendChild(alEl("div", "snote", t("On a Mac, insert the CD and choose it: macOS shows each track as an AIFF file. Choose the CD itself, so its hidden table of contents comes along.")));
  const row = alEl("div", "row");
  const pick = alBtn(t("Choose the CD"), t("The CD as it appears in the Finder"), () => ciPickDir(), "outbtn ciDirBtn");
  const pickF = alBtn(t("Choose the tracks"), t("The AIFF tracks, and .TOC.plist if you can see it"), () => $("ciFiles").click(), "outbtn ciFilesBtn");
  pick.disabled = pickF.disabled = ci.busy || !!ci.doc;
  row.append(pick, pickF);
  src.appendChild(row);
  if (ci.note) src.appendChild(alEl("div", "cinote", ci.note));
  if (!ci.n) return;
  const disc = sec("Disc");
  const len = ci.heads.reduce((a, h) => a + h.frames, 0) / 44100;
  const fromText = ci.from === "drive" ? t("read from the drive") : ci.from === "disc" ? t("table of contents from the disc") : ci.from === "lengths" ? t("table of contents worked out from the track lengths") : "";
  disc.appendChild(alEl("div", "ciinfo", [t("{n} tracks").replace("{n}", ci.n), fmtDur(len), fromText].filter(Boolean).join(" · ")));
  if (ci.ids) disc.appendChild(alEl("div", "ciids", "MusicBrainz " + ci.ids.mb + " · AccurateRip " + ci.ids.ar.slice(5, -4) + " · FreeDB " + ci.ids.freedb));
  if (ci.from === "lengths") disc.appendChild(alEl("div", "snote", t("Without the hidden table of contents a hidden first track or a data track is missed and the disc is not found.")));
  if (ci.disc) {
    const D = ci.disc, extra = [];
    if (ci.htoa) extra.push(t("hidden track before track 1 ({t})").replace("{t}", fmtDur(ci.htoa / 75)));
    else if (D.htoa) extra.push(t("silent pregap before track 1 ({t})").replace("{t}", fmtDur(D.htoa.sectors / 75)));
    if (D.pregaps && D.pregaps.length) extra.push(t("pregaps") + ": " + D.pregaps.map(p => p.track + " (" + ((ci.toc.offsets[p.track - 1] - CI_LEAD - p.index0) / 75).toFixed(2) + " s)").join(", "));
    if (D.mcn) extra.push("MCN " + D.mcn);
    if (D.isrc && D.isrc.some(Boolean)) extra.push(t("ISRC on the disc"));
    if (ci.cdtext) extra.push("CD-Text");
    extra.push(D.c2 ? t("C2 error pointers") : t("no C2 error pointers"));
    if (ci.doff) extra.push(Number.isInteger(ci.doff.offset) ? t("drive offset {o}").replace("{o}", (ci.doff.offset > 0 ? "+" : "") + ci.doff.offset) : t("drive not in the AccurateRip list"));
    disc.appendChild(alEl("div", "snote cidisc", extra.join(" · ")));
  }
  const rel = sec("Release");
  if (ci.mb === "loading") rel.appendChild(alEl("div", "snote", t("Looking the disc up on MusicBrainz…")));
  else if (ci.mb === "none") rel.appendChild(alEl("div", "snote", t(ci.cdtext ? "Not found on MusicBrainz: the names come from the disc's CD-Text." : "Not found on MusicBrainz. Name the album and the tracks yourself.")));
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
  const rip = ci.src === "bridge";
  const tbl = alEl("div", "citbl" + (rip ? " rip" : ""));
  tbl.append(alEl("span", "cdh", "#"), alEl("span", "cdh", t("Length")), alEl("span", "cdh", t("Title")), alEl("span", "cdh", t("Artist")), alEl("span", "cdh", "ISRC"));
  if (rip) tbl.appendChild(alEl("span", "cdh", t("Read")));
  tbl.appendChild(alEl("span", "cdh", "AccurateRip"));
  ci.heads.forEach((h, i) => {
    const k = E.tracks[i], ti = cdInput("ciT", k.title, t("Track {n}").replace("{n}", i + 1), x => { k.title = x.trim(); }), ta = cdInput("ciA", k.artist, E.artist, x => { k.artist = x.trim(); }), tc = cdInput("ciI", k.isrc, "CCXXXYYNNNNN", x => { k.isrc = x.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
    ti.disabled = ta.disabled = tc.disabled = lock;
    const ar = ciArText(i);
    tbl.append(alEl("span", "cdn", String(i + 1)), alEl("span", "cdtm", fmtDur(h.frames / 44100)), ti, ta, tc);
    if (rip) { const rt = ciReadText(i); tbl.appendChild(alEl("span", "ciar ciread" + (rt.startsWith("✓") ? " ok" : rt.startsWith("⚠") ? " bad" : ""), rt)); }
    tbl.appendChild(alEl("span", "ciar" + (ar.startsWith("✓") ? " ok" : ar.startsWith("✗") ? " bad" : ""), ar));
  });
  rel.appendChild(tbl);
  const chk = alEl("div", "cdchk");
  const sm = ciSummary();
  if (sm) chk.appendChild(alEl("div", sm.good ? "ok" : "bad", (sm.good ? "✓ " : "⚠ ") + sm.text));
  if (ci.report) {
    const R = ci.report;
    const first = ci.toc.offsets[0] - CI_LEAD, where = [...new Set(R.suspect.map(l => l < first ? t("the hidden track") : t("track {n}").replace("{n}", ci.toc.offsets.findIndex((o, i) => l >= o - CI_LEAD && l < o - CI_LEAD + ci.toc.lens[i]) + 1)))].join(", ");
    const bad = R.suspect.length === 1 ? t("1 sector could not be read the same way twice, in {w}. Listen there.") : t("{n} sectors could not be read the same way twice, in {w}. Listen there.").replace("{n}", R.suspect.length);
    chk.appendChild(alEl("div", R.suspect.length ? "bad" : "ok", R.suspect.length ? "⚠ " + bad.replace("{w}", where) : "✓ " + t("Every sector read the same way at least twice ({n} re-read).").replace("{n}", R.fixed.length)));
  }
  if (!ci.doc && !rip) chk.appendChild(alEl("div", "ok", "ℹ " + t("macOS reads the disc once, without re-reading bad spots. AccurateRip tells whether the rip matches everyone else's.")));
  rel.appendChild(chk);
  if (ci.busy && ci.n) {
    const pr = alEl("div", "ciprog");
    const bar = alEl("div", "dxbar");
    bar.append(alEl("div", "dxfill cifill"), alEl("span", "snote dxstep cistep", t("Reading")));
    const row2 = alEl("div", "row");
    row2.append(alEl("span", "snote cipct", "0%"), alBtn(t("cancel"), "", () => ciCancel(), "outbtn cicancel"));
    pr.append(bar, row2);
    rel.appendChild(pr);
  }
  const btns = alEl("div", "cdbtns");
  if (!ci.doc) {
    const go = alBtn(rip ? t("Rip securely and verify") : t("Import and verify"), rip ? t("Rips the disc through the Delicate Bridge into one Studio file with the tracks as range markers, checks it against AccurateRip and makes an album") : t("Reads every track into one Studio file with the tracks as range markers, checks it against AccurateRip and makes an album"), () => ciImport(), "outbtn cigo");
    go.disabled = ci.busy || ci.mb === "loading" || ci.arState === "loading";
    btns.appendChild(go);
  } else {
    btns.append(alBtn(t("Open the album"), t("The album with this CD as its side, for Discogs, the CD section and the exports"), () => ciOpenAlbum(), "outbtn cialbum"), alBtn(t("Open the file"), t("Open the rip in the waveform"), () => ciOpenDoc(), "outbtn cidoc"), alBtn(t("Import another CD"), "", () => { ciReset(); ciRender(); }, "outbtn ciagain"));
  }
  rel.appendChild(btns);
}

function ciProg(m) {
  if (!ci.busy || $("cdi").classList.contains("hidden")) return false;
  const box = document.querySelector("#cdi .ciprog");
  if (!box) return true;
  box.querySelector(".cistep").textContent = m.phase === "verify" ? t("Checking against AccurateRip") : m.phase === "rip" ? t("Ripping securely") : t("Reading");
  box.querySelector(".cifill").style.width = Math.round(Math.min(1, m.frac || 0) * 100) + "%";
  box.querySelector(".cipct").textContent = Math.round(Math.min(1, m.frac || 0) * 100) + "%";
  return true;
}

function ciCancel() {
  brAbort();
  ed.worker.postMessage({ t: "cancel" });
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

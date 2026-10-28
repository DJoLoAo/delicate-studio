const XP_RATES = [0, 44100, 48000, 88200, 96000, 176400, 192000];
const XP_DEFAULT = { range: "all", formats: [{ type: "wav", bits: 24, rate: 0 }], gain: 0, dither: "tpdf", shaping: "off", tplFile: "$name", tplRange: "$index $range", dest: "download", folder: "Studio", marks: "file", cue: "off", crate: 0 };
const XP_TRACK = new Set(["TITLE", "TRACKNUMBER", "ISRC", "CUESHEET"]);
const xp = { cfg: null, jobs: [], seq: 0, pics: {}, batches: [], docPics: {}, album: null };

function xpLoad() {
  let v = null;
  try { v = JSON.parse(localStorage.getItem("studioExport") || "null"); } catch {}
  xp.cfg = Object.assign({}, XP_DEFAULT, v && typeof v === "object" ? v : {});
  if (!Array.isArray(xp.cfg.formats) || !xp.cfg.formats.length) xp.cfg.formats = XP_DEFAULT.formats.map(f => Object.assign({}, f));
}

function xpSave() {
  try { localStorage.setItem("studioExport", JSON.stringify(xp.cfg)); } catch {}
}

function xpRanges() {
  return (ed.marks || []).filter(m => m.kind === "range").slice().sort((a, b) => a.a - b.a);
}

function xpRateLabel(r) {
  return (r / 1000).toLocaleString("en", { maximumFractionDigits: 1 }) + "k";
}

function xpBitsLabel(bits) {
  return t(bits === 32 ? "32-bit float" : bits + "-bit");
}

function xpFmtLabel(f, srcRate) {
  const r = f.rate || srcRate;
  return (f.type === "flac" ? "FLAC" : "WAV") + " " + xpBitsLabel(f.bits) + " · " + (r / 1000).toLocaleString() + " kHz";
}

function xpErr(e) {
  if (e === "login") return t("Your session has ended. Log in again.");
  if (e === "locker-full") return t("The Locker is full. The file was not saved there.");
  if (e === "quota") return t("Browser storage is full. Clear finished renders or remove files from Studio's list to make room.");
  return e || "";
}

function xpClean(s) {
  const parts = String(s).replace(/[\u0000-\u001f]/g, "").replace(/[\\/:*?"<>|]/g, "-").split(/\s+-\s+/).map(x => x.trim()).filter(Boolean);
  return parts.join(" - ").replace(/\s{2,}/g, " ").replace(/^[\s.]+|[\s.]+$/g, "").slice(0, 180);
}

function xpTitle(p) {
  const g = p.tag;
  if (!g) return p.range || "";
  if (p.range && g.name && p.range !== g.name) return g.pos && p.range.startsWith(g.pos + " ") ? p.range.slice(g.pos.length + 1).trim() : p.range;
  return g.title || p.range || "";
}

function xpDoc() {
  return xp.album ? xp.album.sides[0].info : ed.doc;
}

function xpDocTags(d) {
  const x = d || ed.doc, tg = tgClean(x.tags || []), src = x.source || {};
  if (tg.length) return tg;
  return tgClean([["TITLE", src.title], ["ARTIST", src.artist], ["ALBUM", src.album]]);
}

function xpTags(p) {
  const g = p.tag, doc = xpDocTags(p.doc), out = [];
  const add = (k, v) => { const s = String(v == null ? "" : v).trim(); if (s && s !== "0") out.push([k, s]); };
  if (!p.range && !g) return doc;
  if (g) {
    add("TITLE", xpTitle(p));
    add("ARTIST", g.artist);
    add("ALBUM ARTIST", g.albumArtist);
    add("ALBUMARTIST", g.albumArtist);
    add("ALBUM", g.album);
    add("TRACKNUMBER", g.pos || p.index);
    add("TRACKTOTAL", g.total);
    add("DISCNUMBER", g.disc);
    add("DISCTOTAL", g.discs);
    add("DATE", g.year);
    add("ORGANIZATION", g.label);
    add("CATALOGNUMBER", g.catno);
    for (const v of String(g.genre || "").split(",")) add("GENRE", v);
    for (const v of String(g.style || "").split(",")) add("STYLE", v);
    add("MEDIA", String(g.format || "").split(",")[0]);
    add("CUSTOM2", g.release);
    add("CUSTOM4", g.country);
    add("CUSTOM5", g.format);
    add("ISRC", g.isrc);
    add("BARCODE", g.upc);
  } else {
    add("TITLE", p.range);
    if (p.index) add("TRACKNUMBER", p.index);
  }
  const have = new Set(out.map(x => x[0]));
  if (have.has("ALBUMARTIST")) have.add("ALBUM ARTIST");
  for (const [k, v] of doc) if (!XP_TRACK.has(k) && !have.has(k)) out.push([k, v]);
  return out;
}

function xpMarks(p) {
  const out = [];
  for (const m of (p.doc ? p.doc.marks : ed.marks) || []) {
    if (m.kind === "point") { if (m.a >= p.a && m.a < p.b) out.push({ a: m.a - p.a, name: m.name || t("Marker") + " " + m.n }); continue; }
    if (m.kind !== "range") continue;
    const a = Math.max(p.a, m.a), b = Math.min(p.b, m.b);
    if (b > a && !(m.a <= p.a && m.b >= p.b)) out.push({ a: a - p.a, b: b - p.a, name: m.name || t("Range") + " " + m.n, isrc: m.tag && m.tag.isrc || "", tag: m.tag || null });
  }
  return out.sort((x, y) => x.a - y.a);
}

function xpCueTracks(marks, sr, d) {
  const ranges = marks.filter(m => m.b > m.a);
  if (ranges.length) return ranges.map(m => ({ title: xpTitle({ range: m.name, tag: m.tag }), performer: m.tag && m.tag.artist || "", isrc: m.isrc, at: m.a / sr }));
  const list = marks.map(m => ({ title: m.name, at: m.a / sr }));
  if (!list.length || list[0].at > 0) list.unshift({ title: tgGet(xpDocTags(d), "TITLE"), at: 0 });
  return list;
}

function xpCueHead(d) {
  const A = xp.album;
  if (A) return { title: A.title, performer: A.artist, genre: A.genre, date: A.year, catalog: A.upc || "" };
  const tg = xpDocTags(d);
  return { title: tgGet(tg, "ALBUM") || tgGet(tg, "TITLE"), performer: tgGet(tg, "ALBUMARTIST") || tgGet(tg, "ARTIST"), genre: tgAll(tg, "GENRE").join(", "), date: tgGet(tg, "DATE"), catalog: tgGet(tg, "BARCODE") };
}

function xpCueText(files, d) {
  return tgCueText(Object.assign(xpCueHead(d), { files }));
}

function xpCues(plan) {
  const c = xp.cfg, out = [];
  for (const f of c.formats) {
    const ps = plan.filter(p => p.fmt.type === f.type && p.fmt.bits === f.bits && p.fmt.rate === f.rate);
    if (!ps.length) continue;
    if (c.range === "ranges" || xp.album) {
      let base = xpName(c.tplFile, { fmt: f });
      if (c.formats.length > 1) base += " (" + f.type + (f.bits === 32 ? "32f" : f.bits) + ")";
      out.push({ name: base + ".cue", text: xpCueText(ps.map(p => ({ name: p.name, tracks: [{ title: xpTitle(p), performer: p.tag && p.tag.artist || "", isrc: p.tag && p.tag.isrc || "", at: 0 }] }))) });
    } else for (const p of ps) out.push({ name: p.name.replace(/\.[^.]+$/, "") + ".cue", ext: p.fmt.type, text: xpCueText([{ name: p.name, tracks: xpCueTracks(p.marks, ed.doc.sampleRate) }]) });
  }
  const n = {};
  for (const q of out) n[q.name] = (n[q.name] || 0) + 1;
  for (const q of out) if (n[q.name] > 1 && q.ext) q.name = q.name.replace(/\.cue$/, "") + " (" + q.ext.toUpperCase() + ").cue";
  return out;
}

async function xpDocPic(d) {
  const x = d || ed.doc;
  if (!x || !x.cover) return null;
  if (x.id in xp.docPics) return xp.docPics[x.id];
  let pic = null;
  try { const r = await call({ t: "tagsget", id: x.id }); if (r.cover) pic = { mime: r.cover.mime, w: r.cover.w, h: r.cover.h, data: r.cover.data }; } catch {}
  xp.docPics[x.id] = pic;
  return pic;
}

function xpBlob(name, text, type) {
  const url = URL.createObjectURL(new Blob([text], { type: type || "application/x-cue" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}

function xpName(tpl, ctx) {
  const x = ctx.doc || xpDoc(), src = x.source || {}, g = ctx.tag;
  const stem = xp.album ? xp.album.title : x.name.replace(/\.[^.]+$/, "");
  const d = new Date();
  const map = {
    name: stem, range: ctx.range || "", index: ctx.index ? String(ctx.index).padStart(2, "0") : "", position: g ? g.pos || "" : "",
    artist: g ? g.artist || "" : src.artist || "", title: g ? xpTitle(ctx) : src.title || stem, album: g ? g.album || "" : src.album || "",
    date: d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"),
    rate: xpRateLabel(ctx.fmt.rate || x.sampleRate), bits: ctx.fmt.bits === 32 ? "32f" : String(ctx.fmt.bits)
  };
  return xpClean(tpl.replace(/\$(name|range|index|position|artist|title|album|date|rate|bits)/g, (_, k) => map[k])) || "export";
}

function xpAlbumPieces() {
  const A = xp.album, out = [];
  if (A.pieces) return A.pieces;
  let index = 0;
  for (const s of A.sides) {
    const ranges = (s.info.marks || []).filter(m => m.kind === "range").sort((x, y) => x.a - y.a);
    ranges.forEach((m, j) => { index++; out.push({ a: m.a, b: Math.min(s.info.frames, m.b), range: m.name || t("Range") + " " + m.n, index, tag: alTag(m, s, j, A), doc: s.info }); });
  }
  return out;
}

function xpPlan() {
  const c = xp.cfg, A = xp.album;
  let pieces = [];
  if (A) pieces = xpAlbumPieces();
  else {
    const F = ed.doc.frames;
    if (c.range === "sel" && selOn()) pieces = [{ a: ed.sel.a, b: ed.sel.b, range: "", index: 0 }];
    else if (c.range === "ranges") pieces = xpRanges().map((m, i) => ({ a: m.a, b: Math.min(F, m.b), range: m.name || t("Range") + " " + m.n, index: i + 1, tag: m.tag || null }));
    else pieces = [{ a: 0, b: F, range: "", index: 0 }];
  }
  const tpl = A || c.range === "ranges" ? c.tplRange : c.tplFile;
  const byExt = {};
  for (const f of c.formats) byExt[f.type] = (byExt[f.type] || 0) + 1;
  const out = [], used = new Set();
  for (const p of pieces) {
    const d = p.doc || ed.doc;
    for (const f of c.formats) {
      let base = xpName(tpl, Object.assign({ fmt: f }, p));
      if (byExt[f.type] > 1) base += " (" + (f.bits === 32 ? "32f" : f.bits) + "-" + xpRateLabel(f.rate || d.sampleRate) + ")";
      let name = base + "." + f.type;
      for (let i = 2; used.has(name.toLowerCase()); i++) name = base + " (" + i + ")." + f.type;
      used.add(name.toLowerCase());
      out.push({ a: p.a, b: p.b, name, fmt: Object.assign({}, f), tags: xpTags(p), pos: p.tag ? p.tag.pos || "" : "", cover: p.tag ? p.tag.cover || "" : "", release: p.tag ? p.tag.release || "" : "", marks: c.marks === "off" ? [] : xpMarks(p), range: p.range, index: p.index, tag: p.tag || null, doc: p.doc || null });
    }
  }
  return out;
}

function xpBytes(job) {
  const d = job.doc || ed.doc, r = job.fmt.rate || d.sampleRate, frames = (job.b - job.a) * r / d.sampleRate;
  const bytes = frames * d.channels * (job.fmt.bits >> 3);
  return job.fmt.type === "flac" ? bytes * 0.62 : bytes;
}

function xpRender() {
  const A = xp.album;
  if (!A && !ed.doc) return;
  const c = xp.cfg, d0 = xpDoc(), nr = A ? 0 : xpRanges().length, hasSel = !A && selOn();
  if (!A && c.range === "sel" && !hasSel) c.range = "all";
  if (!A && c.range === "ranges" && !nr) c.range = "all";
  document.querySelectorAll("#xRange button").forEach(b => {
    b.classList.toggle("on", !A && b.dataset.v === c.range);
    b.disabled = !!A || (b.dataset.v === "sel" && !hasSel) || (b.dataset.v === "ranges" && !nr);
  });
  const nt = A ? xpAlbumPieces().length : 0;
  $("xRangeInfo").textContent = A && A.pieces ? t("Release from the montage") + " · " + (nt === 1 ? t("1 track") : t("{n} tracks").replace("{n}", nt)) : A ? t("Album") + " · " + (nt === 1 ? t("1 track") : t("{n} tracks").replace("{n}", nt)) + " · " + (A.sides.length === 1 ? t("1 side") : t("{n} sides").replace("{n}", A.sides.length)) : c.range === "sel" ? fmtTime(ed.sel.a) + "–" + fmtTime(ed.sel.b) : c.range === "ranges" ? nr + " " + t(nr === 1 ? "file per format" : "files per format") : fmtDur(ed.doc.frames / ed.doc.sampleRate);
  const box = $("xFormats");
  box.innerHTML = "";
  c.formats.forEach((f, i) => {
    const row = document.createElement("div");
    row.className = "xfmt";
    row.innerHTML = `<div class="dd down" data-k="type"><div class="cur"></div><div class="list"></div></div><div class="dd down" data-k="bits"><div class="cur"></div><div class="list"></div></div><div class="dd down" data-k="rate"><div class="cur"></div><div class="list"></div></div><button class="x" title="Remove" aria-label="Remove">×</button>`;
    box.appendChild(row);
    ddInit(row.querySelector("[data-k=type]"), [{ v: "wav", label: "WAV" }, { v: "flac", label: "FLAC" }], f.type, v => { f.type = v; if (v === "flac" && f.bits === 32) f.bits = 24; xpSave(); xpRender(); });
    const bitsItems = [16, 24].concat(f.type === "wav" ? [32] : []).map(b => ({ v: String(b), label: xpBitsLabel(b) }));
    ddInit(row.querySelector("[data-k=bits]"), bitsItems, String(f.bits), v => { f.bits = Number(v); xpSave(); xpRender(); });
    ddInit(row.querySelector("[data-k=rate]"), XP_RATES.map(r => ({ v: String(r), label: r ? (r / 1000).toLocaleString() + " kHz" : t("Same as file") + " (" + (d0.sampleRate / 1000).toLocaleString() + " kHz)" })), String(f.rate), v => { f.rate = Number(v); xpSave(); xpRender(); });
    const x = row.querySelector(".x");
    x.disabled = c.formats.length < 2;
    x.addEventListener("click", () => { c.formats.splice(i, 1); xpSave(); xpRender(); });
  });
  $("xGain").value = (Number(c.gain) || 0).toFixed(1);
  const allFloat = c.formats.every(f => f.type === "wav" && f.bits === 32);
  document.querySelectorAll("#xDither button").forEach(b => { b.classList.toggle("on", b.dataset.v === c.dither); b.disabled = allFloat; });
  document.querySelectorAll("#xShape button").forEach(b => { b.classList.toggle("on", b.dataset.v === c.shaping); b.disabled = allFloat || c.dither === "off"; });
  const rates = c.formats.map(f => f.rate || d0.sampleRate);
  $("xShapeNote").textContent = c.shaping === "strong" && rates.some(r => r > 50000) ? t("Strong shaping is tuned for 44.1 and 48 kHz; higher rates use light shaping.") : "";
  $("xName").value = A || c.range === "ranges" ? c.tplRange : c.tplFile;
  document.querySelectorAll("#xDest button").forEach(b => b.classList.toggle("on", b.dataset.v === c.dest));
  $("xFolder").value = c.folder;
  $("xFolder").classList.toggle("hidden", c.dest !== "locker");
  $("xCrateRow").classList.toggle("hidden", c.dest !== "locker" || !!xp.album);
  if (c.dest === "locker" && !xp.album) { if (djl.crates) djCrateDd(); else djCrates().then(() => { if (!$("exp").classList.contains("hidden")) djCrateDd(); }); }
  const plan = xpPlan();
  $("xPreview").textContent = plan.slice(0, 3).map(p => (c.dest === "locker" && c.folder ? c.folder.replace(/\/+$/, "") + "/" : "") + p.name).join("  ·  ") + (plan.length > 3 ? "  ·  +" + (plan.length - 3) : "");
  const bytes = plan.reduce((s, p) => s + xpBytes(p), 0);
  $("xSummary").textContent = plan.length + " " + t(plan.length === 1 ? "file" : "files") + " · " + (c.formats.some(f => f.type === "flac") ? "≈ " : "") + fmtBytes(bytes);
  $("xGo").disabled = !plan.length;
  const d = A ? [] : xpDocTags(), np = A ? 0 : (ed.marks || []).filter(m => m.kind === "point").length;
  const head = [tgGet(d, "ARTIST") || tgGet(d, "ALBUMARTIST"), tgGet(d, "ALBUM"), tgGet(d, "TITLE")].filter(Boolean);
  $("xTags").textContent = A ? [A.artist, A.title, A.release ? "Discogs " + A.release.id : t("No Discogs release")].filter(Boolean).join(" · ") : d.length ? head.concat([d.length === 1 ? t("1 tag") : t("{n} tags").replace("{n}", d.length)], ed.doc.cover ? [t("cover")] : []).join(" · ") : t("No tags yet");
  $("xTagsEdit").classList.toggle("hidden", !!A);
  document.querySelectorAll("#xMarks button").forEach(b => b.classList.toggle("on", b.dataset.v === c.marks));
  $("xMarksInfo").textContent = A ? t("Markers inside each track") : np || nr ? [np ? (np === 1 ? t("1 marker") : t("{n} markers").replace("{n}", np)) : "", nr ? (nr === 1 ? t("1 range") : t("{n} ranges").replace("{n}", nr)) : ""].filter(Boolean).join(", ") + (c.marks === "file" ? " — " + t("WAV: cue points and BWF time stamp; FLAC: ranges as a cuesheet") : "") : t("No markers or ranges in this file");
  const lock = c.dest === "locker";
  document.querySelectorAll("#xCue button").forEach(b => { b.classList.toggle("on", b.dataset.v === (lock ? "off" : c.cue)); b.disabled = lock; });
  $("xCueInfo").textContent = lock ? t("Only when downloading") : c.cue === "on" ? t("Downloads next to the audio") : "";
  xpQueue();
}

function openExport(album) {
  xp.album = album && album.sides ? album : null;
  if (!xp.album && !ed.doc) return;
  closePopovers();
  if (!xp.album && selOn() && xp.cfg.range === "all" && !xp.touched) xp.cfg.range = "sel";
  $("expTitle").textContent = xp.album ? t("Export album") : t("Export");
  $("xPub").classList.toggle("hidden", !!xp.album);
  $("exp").classList.remove("hidden");
  xpRender();
  setTimeout(() => $("xGo").focus(), 30);
}

function closeExport() {
  xp.album = null;
  $("exp").classList.add("hidden");
}

async function xpPic(url) {
  if (!url) return null;
  if (xp.pics[url] !== undefined) return xp.pics[url];
  let pic = null;
  try {
    const r = await fetch("/api/locker/discogs/img?u=" + encodeURIComponent(url));
    const blob = r.ok ? await r.blob() : null;
    if (blob && blob.size <= 4 << 20 && /^image\/(jpeg|png)/.test(blob.type)) {
      let w = 0, h = 0;
      try { const bm = await createImageBitmap(blob); w = bm.width; h = bm.height; bm.close(); } catch {}
      pic = { mime: blob.type.split(";")[0], w, h, data: await blob.arrayBuffer() };
    }
  } catch {}
  xp.pics[url] = pic;
  return pic;
}

function xpBatches() {
  const live = j => ["queued", "rendering", "hashing", "uploading", "verifying"].includes(j.state);
  for (const b of xp.batches.slice()) {
    const js = b.jobs.map(id => xp.jobs.find(j => j.id === id)).filter(Boolean);
    if (js.some(live)) continue;
    xp.batches = xp.batches.filter(x => x !== b);
    const files = js.filter(j => j.state === "done" && j.locker && j.locker.file && j.pos).map(j => ({ file: j.locker.file, position: j.pos }));
    if (!files.length) continue;
    fetch("/api/locker/discogs/apply", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ release: b.release, files }) })
      .then(r => r.ok ? r.json() : null)
      .then(j => { if (j && j.updated) flash(j.updated === 1 ? t("1 file tagged in the Locker from Discogs") : t("{n} files tagged in the Locker from Discogs").replace("{n}", j.updated)); })
      .catch(() => {});
  }
}

async function xpGo() {
  if ((!ed.doc && !xp.album) || xp.going) return;
  const c = xp.cfg;
  const g = Number(String($("xGain").value).replace(",", "."));
  c.gain = Number.isFinite(g) ? Math.max(-60, Math.min(24, g)) : 0;
  xpSave();
  const master = { gain: c.gain, dither: c.dither, shaping: c.shaping };
  const dest = c.dest === "locker" ? { kind: "locker", folder: c.folder } : { kind: "download" };
  const crate = dest.kind === "locker" && !xp.album && c.crate ? { id: c.crate, name: djCrateLabel(c.crate) } : null;
  const doc = ed.doc, A = xp.album, plan = xpPlan(), rel = dest.kind === "locker" ? Number((plan.find(p => p.release) || {}).release) || 0 : 0;
  const batch = rel ? { release: rel, jobs: [] } : null;
  xp.going = true;
  $("xGo").disabled = true;
  try {
    for (const p of plan) {
      const d = p.doc || doc;
      const pic = p.fmt.type === "flac" ? (p.cover ? await xpPic(p.cover) : await xpDocPic(d)) : null;
      if (!A && ed.doc !== doc) break;
      const tags = p.tags.slice();
      if (p.fmt.type === "flac" && p.marks.some(m => m.b > m.a)) tags.push(["CUESHEET", xpCueText([{ name: p.name, tracks: xpCueTracks(p.marks.filter(m => m.b > m.a), d.sampleRate, d) }], d)]);
      const id = "x" + Date.now().toString(36) + (++xp.seq);
      const job = { id, name: p.name, fmt: p.fmt, dest, state: "queued", frac: 0, doc: d.name, fmtLabel: xpFmtLabel(p.fmt, d.sampleRate), len: (p.b - p.a) / d.sampleRate, pos: p.pos, crate, tags };
      xp.jobs.push(job);
      if (batch && p.release) batch.jobs.push(id);
      call({ t: "export", id: d.id, jobId: id, a: p.a, b: p.b, name: p.name, fmt: p.fmt, master, dest, tags, pic, marks: p.marks.map(m => ({ a: m.a, b: m.b, name: m.name, isrc: m.isrc })) }).catch(e => { job.state = "failed"; job.error = e.message; xpQueue(); xpBatches(); });
    }
    if (c.cue === "on" && dest.kind === "download" && (A || ed.doc === doc)) for (const q of xpCues(plan)) xpBlob(q.name, q.text);
    if (A && A.sheet && dest.kind === "download") xpBlob(A.sheet.name, A.sheet.text, "text/csv");
  } finally {
    xp.going = false;
    if (batch && batch.jobs.length) xp.batches.push(batch);
    xpRender();
  }
}

function xpJob(m) {
  const j = xp.jobs.find(x => x.id === m.id);
  if (!j) return;
  const was = j.state;
  Object.assign(j, { state: m.state, frac: m.frac });
  if (m.state === "done") {
    Object.assign(j, { size: m.size, peak: m.peak, clipped: m.clipped, file: m.file, locker: m.locker, ms: m.ms });
    if (was !== "done") {
      if (j.dest.kind === "download") xpDownload(j);
      if (j.pub) pbDone(j);
      else if (j.crate && j.locker) djAddToCrate(j);
      else flash(t("Exported") + " " + (j.locker ? j.locker.path : j.name));
    }
  }
  if (m.state === "failed") {
    j.error = m.error;
    if (was !== "failed") xpFail(j, m);
  }
  xpQueue();
  xpBadge();
  if (["done", "failed", "cancelled"].includes(m.state)) xpBatches();
}

function xpFail(j, m) {
  const e = m.error || "";
  if (e === "login") tell(xpErr(e));
  else if (e === "locker-full" || e === "quota") tell(xpErr(e), t("Could not export"));
  else tell(j.name + ": " + e, t("Could not export"));
}

async function xpFile(j) {
  const root = await navigator.storage.getDirectory();
  const dir = await (await root.getDirectoryHandle("studio")).getDirectoryHandle("exports");
  return (await dir.getFileHandle(j.file)).getFile();
}

async function xpDownload(j) {
  try {
    const f = await xpFile(j);
    const url = URL.createObjectURL(f);
    const a = document.createElement("a");
    a.href = url;
    a.download = j.name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 120000);
  } catch { tell(t("The rendered file is no longer here. Render it again."), t("Could not export")); }
}

function xpBadge() {
  const n = xp.jobs.filter(j => ["queued", "rendering", "hashing", "uploading", "verifying"].includes(j.state)).length;
  $("expN").textContent = n ? String(n) : "";
}

const XP_STATE = { queued: "Waiting", rendering: "Rendering", hashing: "Checking", uploading: "Uploading", verifying: "Saving in the Locker", publishing: "Publishing", done: "Done", failed: "Failed", cancelled: "Cancelled" };

function xpQueue() {
  const box = $("xQueue");
  if (!box) return;
  $("xQueueSec").classList.toggle("hidden", !xp.jobs.length);
  box.innerHTML = "";
  for (const j of xp.jobs.slice().reverse()) {
    const row = document.createElement("div");
    row.className = "xjob " + j.state;
    row.innerHTML = `<div class="xj1"><span class="xn"></span><span class="xs"></span></div><div class="xj2"><span class="xf"></span><span class="xr"></span><span class="grow"></span><span class="xa"></span></div><div class="bbar"><i></i></div>`;
    row.querySelector(".xn").textContent = j.name;
    row.querySelector(".xs").textContent = t(XP_STATE[j.state] || j.state) + (["rendering", "hashing", "uploading"].includes(j.state) || (j.state === "publishing" && j.frac > 0) ? " " + Math.round((j.frac || 0) * 100) + "%" : "");
    row.querySelector(".xf").textContent = j.fmtLabel + " · " + fmtDur(j.len) + (j.pub ? " · " + (j.pub.to === "replay" ? t("Listener page") : t(PB_NAME[j.pub.to])) : j.dest.kind === "locker" ? " · " + t("Locker") : "");
    let res = "";
    if (j.state === "done") {
      const pk = j.peak > 0 ? 20 * Math.log10(j.peak) : -Infinity;
      res = fmtBytes(j.size) + " · " + t("peak") + " " + (pk === -Infinity ? "−∞" : (pk >= 0 ? "+" : "") + pk.toFixed(1)) + " dBFS" + (j.clipped ? " · " + j.clipped.toLocaleString() + " " + t("samples clipped") : "") + (j.locker ? " · " + (j.locker.duplicate ? t("already in the Locker as") + " " : "") + j.locker.path : "");
    } else if (j.state === "failed") res = xpErr(j.error);
    const xr = row.querySelector(".xr");
    xr.textContent = res;
    xr.classList.toggle("warn", !!(j.clipped || j.state === "failed"));
    row.querySelector(".bbar i").style.width = Math.round((j.state === "done" ? 1 : j.frac || 0) * 100) + "%";
    const act = row.querySelector(".xa");
    const live = ["queued", "rendering", "hashing", "uploading", "verifying"].includes(j.state);
    if (j.state === "done" && j.url) {
      const o = document.createElement("a");
      o.className = "outbtn";
      o.href = j.url;
      o.target = "_blank";
      o.rel = "noopener";
      o.textContent = t("open");
      act.appendChild(o);
    }
    if (j.state === "done" && j.dest.kind === "download") {
      const d = document.createElement("button");
      d.className = "outbtn";
      d.textContent = t("download");
      d.addEventListener("click", () => xpDownload(j));
      act.appendChild(d);
    }
    const x = document.createElement("button");
    x.className = "x";
    x.textContent = "×";
    x.title = live ? t("Cancel") : t("Remove");
    x.addEventListener("click", () => {
      if (live) { if (!pbCancel(j)) ed.worker.postMessage({ t: "xcancel", id: j.id }); }
      else { ed.worker.postMessage({ t: "xremove", id: j.id }); xp.jobs = xp.jobs.filter(y => y !== j); xpQueue(); }
    });
    act.appendChild(x);
    box.appendChild(row);
  }
}

function wireExport() {
  xpLoad();
  $("expClose").addEventListener("click", closeExport);
  $("xPub").addEventListener("click", () => { if (xp.album) return; closeExport(); pbOpen(); });
  $("exp").addEventListener("pointerdown", e => { if (e.target === $("exp")) closeExport(); });
  $("exp").addEventListener("keydown", e => { if (e.key === "Escape" && !e.target.closest(".dd.open")) { e.stopPropagation(); closeExport(); } });
  const seg = (id, key, after) => $(id).addEventListener("click", e => {
    const b = e.target.closest("button");
    if (!b || b.disabled) return;
    xp.cfg[key] = b.dataset.v;
    if (key === "range") xp.touched = true;
    xpSave();
    if (after) after();
    xpRender();
  });
  seg("xRange", "range");
  seg("xDither", "dither");
  seg("xShape", "shaping");
  seg("xDest", "dest");
  seg("xMarks", "marks");
  seg("xCue", "cue");
  $("xTagsEdit").addEventListener("click", () => ftOpen(true));
  $("xAddFmt").addEventListener("click", () => {
    const last = xp.cfg.formats[xp.cfg.formats.length - 1];
    xp.cfg.formats.push(last && last.type === "wav" ? { type: "flac", bits: 16, rate: 44100 } : { type: "wav", bits: 24, rate: 0 });
    xpSave();
    xpRender();
  });
  $("xName").addEventListener("input", () => { if (xp.album || xp.cfg.range === "ranges") xp.cfg.tplRange = $("xName").value; else xp.cfg.tplFile = $("xName").value; xpSave(); xpRender(); });
  $("xFolder").addEventListener("input", () => { xp.cfg.folder = $("xFolder").value; xpSave(); xpRender(); });
  $("xGain").addEventListener("change", () => { const g = Number(String($("xGain").value).replace(",", ".")); xp.cfg.gain = Number.isFinite(g) ? Math.max(-60, Math.min(24, g)) : 0; xpSave(); xpRender(); });
  document.querySelectorAll("#xTokens button").forEach(b => b.addEventListener("click", () => {
    const i = $("xName");
    const s = i.selectionStart ?? i.value.length, e2 = i.selectionEnd ?? i.value.length;
    i.value = i.value.slice(0, s) + b.textContent + i.value.slice(e2);
    i.dispatchEvent(new Event("input"));
    i.focus();
    i.setSelectionRange(s + b.textContent.length, s + b.textContent.length);
  }));
  $("xGo").addEventListener("click", xpGo);
  $("xClear").addEventListener("click", () => {
    for (const j of xp.jobs.filter(j => ["done", "failed", "cancelled"].includes(j.state))) ed.worker.postMessage({ t: "xremove", id: j.id });
    xp.jobs = xp.jobs.filter(j => !["done", "failed", "cancelled"].includes(j.state));
    xpQueue();
  });
  document.addEventListener("i18n", () => { if (!$("exp").classList.contains("hidden")) xpRender(); });
}

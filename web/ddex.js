const DX_NS = "http://ddex.net/xml/ern/43";
const DX_AVS = "11";
const DX_DPID = /^PADPIDA[0-9]{10}[0-9A-Z]$/;
const DX_LANGS = ["en", "de", "fr", "es", "it", "pt", "hi", "ja", "ko", "zh", "nl", "sv", "pl", "tr", "ar", "ru", "zxx"];

function dxEsc(v) {
  return String(v == null ? "" : v).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function dxDur(sec) {
  const ms = Math.max(0, Math.round(sec * 1000)), h = Math.floor(ms / 3600000), m = Math.floor(ms / 60000) % 60, s = (ms % 60000) / 1000;
  return "PT" + (h ? h + "H" : "") + m + "M" + (Number.isInteger(s) ? s : s.toFixed(3).replace(/0+$/, "")) + "S";
}

function dxType(durs) {
  const n = durs.length, total = durs.reduce((a, b) => a + b, 0), long = durs.some(d => d >= 600);
  if (total >= 1800 || n >= 7) return "Album";
  if (n <= 3 && !long) return "Single";
  return "EP";
}

function dxNames(v) { return String(v || "").split(/[,;\n]/).map(x => x.trim()).filter(Boolean); }

function dxXml(R) {
  const out = [], e = (d, tag, v, at) => out.push("  ".repeat(d) + "<" + tag + (at ? Object.entries(at).filter(x => x[1] !== undefined && x[1] !== "").map(x => " " + x[0] + "=\"" + dxEsc(x[1]) + "\"").join("") : "") + ">" + dxEsc(v) + "</" + tag + ">");
  const o = (d, tag, at) => out.push("  ".repeat(d) + "<" + tag + (at ? Object.entries(at).filter(x => x[1] !== undefined && x[1] !== "").map(x => " " + x[0] + "=\"" + dxEsc(x[1]) + "\"").join("") : "") + ">");
  const c = (d, tag) => out.push("  ".repeat(d) + "</" + tag + ">");
  const parties = new Map(), pref = name => { if (!parties.has(name)) parties.set(name, "P" + (parties.size + 1)); return parties.get(name); };
  const main = pref(R.artist), label = pref(R.label);
  for (const k of R.tracks) { pref(k.artist || R.artist); for (const w of k.composers.concat(k.lyricists)) pref(w); }
  const warn = k => k.explicit ? "Explicit" : "NotExplicit", anyExplicit = R.tracks.some(k => k.explicit);
  const instr = R.lang === "zxx", W = { ApplicableTerritoryCode: "Worldwide" };
  out.push("<?xml version=\"1.0\" encoding=\"UTF-8\"?>");
  o(0, "ern:NewReleaseMessage", { "xmlns:ern": DX_NS, "xmlns:xsi": "http://www.w3.org/2001/XMLSchema-instance", "xsi:schemaLocation": DX_NS + " " + DX_NS + "/release-notification.xsd", ReleaseProfileVersionId: "Audio", LanguageAndScriptCode: "en", AvsVersionId: DX_AVS });
  o(1, "MessageHeader");
  e(2, "MessageThreadId", R.id);
  e(2, "MessageId", R.id);
  o(2, "MessageSender"); e(3, "PartyId", R.sender.dpid); o(3, "PartyName"); e(4, "FullName", R.sender.name); c(3, "PartyName"); c(2, "MessageSender");
  o(2, "MessageRecipient"); e(3, "PartyId", R.recipient.dpid); o(3, "PartyName"); e(4, "FullName", R.recipient.name); c(3, "PartyName"); c(2, "MessageRecipient");
  e(2, "MessageCreatedDateTime", R.created);
  e(2, "MessageControlType", R.test ? "TestMessage" : "LiveMessage");
  c(1, "MessageHeader");
  o(1, "PartyList");
  for (const [name, ref] of parties) { o(2, "Party"); e(3, "PartyReference", ref); o(3, "PartyName"); e(4, "FullName", name); c(3, "PartyName"); c(2, "Party"); }
  c(1, "PartyList");
  o(1, "ResourceList");
  R.tracks.forEach((k, i) => {
    const n = i + 1, art = k.artist || R.artist;
    o(2, "SoundRecording");
    e(3, "ResourceReference", "A" + n);
    e(3, "Type", "MusicalWorkSoundRecording");
    o(3, "SoundRecordingEdition");
    o(4, "ResourceId"); e(5, "ISRC", k.isrc); c(4, "ResourceId");
    o(4, "PLine"); e(5, "Year", R.pYear); e(5, "PLineCompany", R.pOwner); e(5, "PLineText", "(P) " + R.pYear + " " + R.pOwner); c(4, "PLine");
    o(4, "TechnicalDetails");
    e(5, "TechnicalResourceDetailsReference", "T" + n);
    o(5, "DeliveryFile");
    e(6, "Type", "AudioFile");
    e(6, "AudioCodecType", "FLAC");
    e(6, "NumberOfChannels", "2");
    e(6, "SamplingRate", (k.rate / 1000).toString(), { UnitOfMeasure: "kHz" });
    e(6, "BitsPerSample", String(k.bits));
    e(6, "Duration", dxDur(k.dur));
    o(6, "File"); e(7, "URI", k.file); o(7, "HashSum"); e(8, "Algorithm", "MD5"); e(8, "HashSumValue", k.md5); c(7, "HashSum"); e(7, "FileSize", String(k.size)); c(6, "File");
    c(5, "DeliveryFile");
    c(4, "TechnicalDetails");
    c(3, "SoundRecordingEdition");
    e(3, "DisplayTitleText", k.title);
    o(3, "DisplayTitle", { ApplicableTerritoryCode: "Worldwide", IsDefault: "true" }); e(4, "TitleText", k.title); c(3, "DisplayTitle");
    e(3, "DisplayArtistName", art, { ApplicableTerritoryCode: "Worldwide", IsDefault: "true" });
    o(3, "DisplayArtist", { SequenceNumber: "1" }); e(4, "ArtistPartyReference", pref(art)); e(4, "DisplayArtistRole", "MainArtist"); c(3, "DisplayArtist");
    let seq = 0;
    o(3, "Contributor", { SequenceNumber: String(++seq) }); e(4, "ContributorPartyReference", pref(art)); e(4, "Role", "Artist"); c(3, "Contributor");
    const roles = new Map();
    for (const w of k.composers) roles.set(w, ["Composer"]);
    for (const w of k.lyricists) roles.set(w, (roles.get(w) || []).concat("Lyricist"));
    for (const [w, rs] of roles) { o(3, "Contributor", { SequenceNumber: String(++seq) }); e(4, "ContributorPartyReference", pref(w)); for (const r of rs) e(4, "Role", r); c(3, "Contributor"); }
    e(3, "Duration", dxDur(k.dur));
    e(3, "ParentalWarningType", warn(k));
    e(3, "IsInstrumental", instr ? "true" : "false");
    if (R.hires) e(3, "IsHiResMusic", "true");
    e(3, "LanguageOfPerformance", R.lang);
    c(2, "SoundRecording");
  });
  const img = "A" + (R.tracks.length + 1);
  o(2, "Image");
  e(3, "ResourceReference", img);
  e(3, "Type", "FrontCoverImage");
  o(3, "ResourceId"); e(4, "ProprietaryId", R.upc + "_cover", { Namespace: R.sender.dpid }); c(3, "ResourceId");
  e(3, "ParentalWarningType", "NotExplicit");
  o(3, "TechnicalDetails");
  e(4, "TechnicalResourceDetailsReference", "T" + (R.tracks.length + 1));
  e(4, "ImageCodecType", R.cover.codec);
  e(4, "ImageHeight", String(R.cover.h), { UnitOfMeasure: "Pixel" });
  e(4, "ImageWidth", String(R.cover.w), { UnitOfMeasure: "Pixel" });
  o(4, "File"); e(5, "URI", R.cover.file); o(5, "HashSum"); e(6, "Algorithm", "MD5"); e(6, "HashSumValue", R.cover.md5); c(5, "HashSum"); e(5, "FileSize", String(R.cover.size)); c(4, "File");
  c(3, "TechnicalDetails");
  c(2, "Image");
  c(1, "ResourceList");
  o(1, "ReleaseList");
  o(2, "Release");
  e(3, "ReleaseReference", "R0");
  e(3, "ReleaseType", R.type);
  o(3, "ReleaseId"); e(4, "ICPN", R.upc); if (R.catno) e(4, "CatalogNumber", R.catno, { Namespace: R.sender.dpid }); c(3, "ReleaseId");
  e(3, "DisplayTitleText", R.title);
  o(3, "DisplayTitle", { ApplicableTerritoryCode: "Worldwide", IsDefault: "true" }); e(4, "TitleText", R.title); c(3, "DisplayTitle");
  e(3, "DisplayArtistName", R.artist, { ApplicableTerritoryCode: "Worldwide", IsDefault: "true" });
  o(3, "DisplayArtist", { SequenceNumber: "1" }); e(4, "ArtistPartyReference", main); e(4, "DisplayArtistRole", "MainArtist"); c(3, "DisplayArtist");
  e(3, "ReleaseLabelReference", label, W);
  o(3, "PLine"); e(4, "Year", R.pYear); e(4, "PLineCompany", R.pOwner); e(4, "PLineText", "(P) " + R.pYear + " " + R.pOwner); c(3, "PLine");
  o(3, "CLine"); e(4, "Year", R.cYear); e(4, "CLineCompany", R.cOwner); e(4, "CLineText", "(C) " + R.cYear + " " + R.cOwner); c(3, "CLine");
  e(3, "Duration", dxDur(R.tracks.reduce((a, k) => a + k.dur, 0)));
  o(3, "Genre", W); e(4, "GenreText", R.genre); c(3, "Genre");
  e(3, "ReleaseDate", R.date, W);
  e(3, "OriginalReleaseDate", R.original || R.date, W);
  e(3, "ParentalWarningType", anyExplicit ? "Explicit" : "NotExplicit");
  o(3, "ResourceGroup");
  e(4, "SequenceNumber", "1");
  R.tracks.forEach((k, i) => { o(4, "ResourceGroupContentItem"); e(5, "SequenceNumber", String(i + 1)); e(5, "ReleaseResourceReference", "A" + (i + 1)); c(4, "ResourceGroupContentItem"); });
  e(4, "LinkedReleaseResourceReference", img, { LinkDescription: "CoverArt" });
  c(3, "ResourceGroup");
  if (R.hires) e(3, "IsHiResMusic", "true");
  c(2, "Release");
  R.tracks.forEach((k, i) => {
    o(2, "TrackRelease");
    e(3, "ReleaseReference", "R" + (i + 1));
    o(3, "ReleaseId"); e(4, "ProprietaryId", R.upc + "_" + k.isrc, { Namespace: R.sender.dpid }); c(3, "ReleaseId");
    e(3, "ReleaseResourceReference", "A" + (i + 1));
    e(3, "ReleaseLabelReference", label, W);
    o(3, "Genre", W); e(4, "GenreText", R.genre); c(3, "Genre");
    c(2, "TrackRelease");
  });
  c(1, "ReleaseList");
  o(1, "DealList");
  o(2, "ReleaseDeal");
  for (let i = 0; i <= R.tracks.length; i++) e(3, "DealReleaseReference", "R" + i);
  const deal = (models, uses) => {
    o(3, "Deal"); o(4, "DealTerms");
    e(5, "TerritoryCode", "Worldwide");
    o(5, "ValidityPeriod"); e(6, "StartDate", R.date); c(5, "ValidityPeriod");
    for (const m of models) e(5, "CommercialModelType", m);
    for (const u of uses) e(5, "UseType", u);
    c(4, "DealTerms"); c(3, "Deal");
  };
  if (R.stream) deal(["SubscriptionModel", "AdvertisementSupportedModel"], ["OnDemandStream", "NonInteractiveStream"]);
  if (R.download) deal(["PayAsYouGoModel"], ["PermanentDownload"]);
  c(2, "ReleaseDeal");
  c(1, "DealList");
  c(0, "ern:NewReleaseMessage");
  return out.join("\n") + "\n";
}

const dx = { job: null, n: 0, cover: {} };
const DX_KEEP = "studio.ddex.parties";

function dxKeep() { try { return JSON.parse(localStorage.getItem(DX_KEEP) || "{}") || {}; } catch { return {}; } }

function dxParty(own, kept) {
  const f = x => (own && own[x]) || (kept && kept[x]) || "";
  return { name: f("name"), dpid: f("dpid") };
}

function dxCfg(A) {
  const rel = A.release || {}, d = A.ddex || {}, k = dxKeep(), has = f => d[f] !== undefined && d[f] !== null;
  return {
    label: has("label") ? d.label : rel.label || "", date: d.date || "", genre: has("genre") ? d.genre : rel.genre || "", catno: has("catno") ? d.catno : rel.catno || "",
    pOwner: d.pOwner || "", pYear: d.pYear || "", cOwner: d.cOwner || "", cYear: d.cYear || "", lang: d.lang || "en", type: d.type || "",
    sender: dxParty(d.sender, k.sender), recipient: dxParty(d.recipient, k.recipient),
    stream: d.stream !== false, download: d.download !== false, test: !!d.test, cover: d.cover || null
  };
}

function dxEff(C) {
  const y = (C.date || "").slice(0, 4) || String(new Date().getFullYear());
  return { pOwner: C.pOwner || C.label, pYear: C.pYear || y, cOwner: C.cOwner || C.label, cYear: C.cYear || y };
}

function dxDurs(s) {
  const L = cdClips(s), sr = s.sr || 44100;
  return L.map((k, i) => (i + 1 < L.length ? L[i + 1].at - k.at : k.len) / sr);
}

function dxHires(src) { return !!(src && src.bits >= 24 && !src.lossy.length); }

function dxCheck(A, s, src) {
  const C = dxCfg(A), E = dxEff(C), L = cdClips(s), out = [], need = (good, ok, bad) => out.push({ good, text: good ? ok : bad });
  const upc = (A.cd && A.cd.upc) || "";
  need(!!upc && cdUpcOk(upc), t("UPC/EAN checks out"), upc ? t("UPC/EAN check digit is wrong") : t("The stores need a UPC/EAN: enter it in the CD section above."));
  const isrc = L.map(k => (k.cd && k.cd.isrc) || ""), badI = isrc.filter(v => v && !cdIsrcOk(v)), dup = isrc.filter((v, i) => v && isrc.indexOf(v) !== i), miss = L.filter((k, i) => !isrc[i]).map((k, i) => (k.cd && k.cd.title) || k.name);
  if (badI.length) need(false, "", t("ISRC not in the form CC-XXX-YY-NNNNN") + ": " + badI.join(", "));
  else if (dup.length) need(false, "", t("The same ISRC on two tracks") + ": " + [...new Set(dup)].join(", "));
  else need(!miss.length, t("ISRC on every track"), t("Every track needs an ISRC") + ": " + miss.join(", "));
  need(!!((A.cd && A.cd.title) || alTitle(A)) && L.every(k => (k.cd && k.cd.title) || k.name), t("Titles for the release and every track"), t("Give the release and every track a title."));
  need(!!((A.cd && A.cd.performer) || alArtist(A)), t("Main artist named"), t("Name the main artist (Performer in the CD section)."));
  need(!!C.label, t("Label named"), t("Name the label. Self-released: your artist name."));
  need(!!calParse(C.date), t("Release date set"), t("Set the release date."));
  if (calParse(C.date) && calParse(C.date) - new Date() < 14 * 864e5) out.push({ good: false, soft: true, text: t("The release date is less than two weeks away: stores and playlist pitching need lead time, four weeks is common.") });
  need(!!C.genre, t("Genre set"), t("Set the genre."));
  need(!!E.pOwner && !!E.cOwner, t("℗ and © lines complete"), t("The ℗ and © lines need an owner."));
  const cv = C.cover;
  if (!cv) need(false, "", t("Choose the cover: a square JPEG or PNG, 3000 × 3000 pixels."));
  else if (cv.w !== cv.h) need(false, "", t("The cover is {w} × {h}: it has to be square.").replace("{w}", cv.w).replace("{h}", cv.h));
  else if (cv.w < 1400) need(false, "", t("The cover is {w} × {h}: too small, the stores take 3000 × 3000.").replace("{w}", cv.w).replace("{h}", cv.h));
  else if (cv.w < 3000) out.push({ good: false, soft: true, text: t("The cover is {w} × {h}: most stores want 3000 × 3000.").replace("{w}", cv.w).replace("{h}", cv.h) });
  else need(true, t("Cover {w} × {h}").replace("{w}", cv.w).replace("{h}", cv.h), "");
  need(!!C.sender.name && DX_DPID.test(C.sender.dpid), t("Sender with a DDEX Party ID"), t("Your name and DDEX Party ID (PADPIDA…) as the sender. DDEX issues one free of charge."));
  need(!!C.recipient.name && DX_DPID.test(C.recipient.dpid), t("Distributor with a DDEX Party ID"), t("The distributor's name and DDEX Party ID (PADPIDA…). Ask them for it."));
  need(C.stream || C.download, t("Offered for {d}").replace("{d}", [C.stream ? t("streaming") : "", C.download ? t("download") : ""].filter(Boolean).join(" " + t("and") + " ")), t("Offer it for streaming, download or both."));
  const noW = L.filter(k => !dxNames(k.cd && k.cd.composer).length).map(k => (k.cd && k.cd.title) || k.name);
  out.push({ good: !noW.length, soft: true, text: noW.length ? t("No songwriter on {t}: Spotify, Apple Music and the collecting societies need them.").replace("{t}", noW.join(", ")) : t("Songwriters on every track") });
  if (src) out.push({ good: !src.lossy.length, soft: true, text: dxHires(src) ? t("Audio: FLAC 24-bit at {r} kHz, marked as hi-res").replace("{r}", ((s.sr || 44100) / 1000).toLocaleString(i18n.lang || undefined)) : src.lossy.length ? t("Made from lossy files: the stores may refuse it.") : t("Audio: FLAC 16-bit/44.1 kHz with dither") });
  return out;
}

async function dxSet(A, patch) {
  const C = al.list.find(x => x.id === A.id) || A;
  C.ddex = Object.assign({}, C.ddex || {}, patch);
  A.ddex = C.ddex;
  if (patch.sender || patch.recipient) { try { const k = dxKeep(); localStorage.setItem(DX_KEEP, JSON.stringify(Object.assign(k, patch.sender ? { sender: C.ddex.sender } : {}, patch.recipient ? { recipient: C.ddex.recipient } : {}))); } catch {} }
  await alSave();
  if (al.cur) alRenderCd(al.cur);
}

async function dxCoversDir(create) {
  const root = await navigator.storage.getDirectory(), st = await root.getDirectoryHandle("studio", { create: true });
  return st.getDirectoryHandle("covers", { create });
}

async function dxCoverBytes(A) {
  try { return new Uint8Array(await (await (await (await dxCoversDir(false)).getFileHandle(A.id)).getFile()).arrayBuffer()); } catch { return null; }
}

async function dxCoverUrl(A) {
  const C = dxCfg(A);
  if (!C.cover) return "";
  const k = A.id + ":" + C.cover.at;
  if (dx.cover[k]) return dx.cover[k];
  const b = await dxCoverBytes(A);
  if (!b) return "";
  return (dx.cover[k] = URL.createObjectURL(new Blob([b], { type: C.cover.mime })));
}

function dxPickCover(A) {
  const inp = document.createElement("input");
  inp.type = "file";
  inp.accept = "image/jpeg,image/png";
  inp.addEventListener("change", async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    if (!/^image\/(jpeg|png)$/.test(f.type)) { tell(t("Use a JPEG or PNG file."), t("Could not use the cover")); return; }
    if (f.size > 40 << 20) { tell(t("The file is larger than 40 MB."), t("Could not use the cover")); return; }
    let w = 0, h = 0;
    try { const bm = await createImageBitmap(f); w = bm.width; h = bm.height; bm.close(); } catch { tell(t("The image could not be read."), t("Could not use the cover")); return; }
    try {
      const fh = await (await dxCoversDir(true)).getFileHandle(A.id, { create: true }), wr = await fh.createWritable();
      await wr.write(f);
      await wr.close();
    } catch (e) { tell(String(e.message || e), t("Could not use the cover")); return; }
    dxSet(A, { cover: { name: f.name, mime: f.type, w, h, size: f.size, at: Date.now() } });
  });
  inp.click();
}

function dxDd(cls, items, value, onChange) {
  const dd = alEl("div", "dd down " + cls);
  dd.innerHTML = '<div class="cur"></div><div class="list"></div>';
  ddInit(dd, items, value, onChange);
  return dd;
}

function dxLangName(code) {
  if (code === "zxx") return t("Instrumental");
  try { return new Intl.DisplayNames([i18n.lang || "en"], { type: "language" }).of(code); } catch { return code; }
}

async function dxRender(A) {
  const box = $("albDdex");
  if (!box) return;
  const n = ++dx.n, s = await cdSession(A);
  if (n !== dx.n || al.cur !== A) return;
  if (!s) { box.textContent = ""; box.appendChild(alEl("div", "snote", t("Make the montage in the CD section first; the package is made from it."))); return; }
  const src = await sqSources(A, s), url = await dxCoverUrl(A);
  if (n !== dx.n || al.cur !== A) return;
  box.textContent = "";
  const C = dxCfg(A), E = dxEff(C), L = cdClips(s), durs = dxDurs(s), auto = dxType(durs);
  box.appendChild(alEl("div", "snote", t("A DDEX ERN 4.3 delivery for a distributor: the XML with every credit and right, one FLAC per track and the cover, in one zip.")));
  const top = alEl("div", "dxtop");
  const cov = alEl("button", "dxcover" + (url ? "" : " none"));
  cov.type = "button";
  cov.title = t("Choose the cover: a square JPEG or PNG, 3000 × 3000 pixels.");
  if (url) { const im = alEl("img", ""); im.src = url; im.alt = ""; cov.appendChild(im); } else cov.textContent = t("Cover");
  cov.addEventListener("click", () => dxPickCover(A));
  const head = alEl("div", "cdhead dxhead");
  const date = alEl("button", "xtext dxdate" + (C.date ? "" : " empty"), C.date ? calFmt(C.date) : t("Choose a date"));
  date.type = "button";
  date.addEventListener("click", () => calOpen(date, C.date, v => dxSet(A, { date: v })));
  const types = [{ v: "", label: t("Automatic") + " · " + t(auto) }, { v: "Album", label: "Album" }, { v: "EP", label: "EP" }, { v: "Single", label: "Single" }];
  head.append(
    alEl("label", "", t("Label")), cdInput("dxlabel", C.label, t("Label or your artist name"), v => dxSet(A, { label: v.trim() })),
    alEl("label", "", t("Release date")), date,
    alEl("label", "", t("Genre")), cdInput("dxgenre", C.genre, "Electronic", v => dxSet(A, { genre: v.trim() })),
    alEl("label", "", t("Type")), dxDd("dxtype", types, C.type, v => dxSet(A, { type: v })),
    alEl("label", "", t("Language")), dxDd("dxlang", DX_LANGS.map(v => ({ v, label: dxLangName(v) })), C.lang, v => dxSet(A, { lang: v })),
    alEl("label", "", t("Catalog no.")), cdInput("dxcat", C.catno, "DA001", v => dxSet(A, { catno: v.trim() })));
  const lines = alEl("div", "cdhead dxhead");
  const yr = (cls, v, ph, f) => { const i = cdInput(cls, v, ph, x => { const y = x.replace(/\D/g, "").slice(0, 4); dxSet(A, { [f]: y.length === 4 ? y : "" }); }); i.inputMode = "numeric"; return i; };
  lines.append(
    alEl("label", "", "℗"), alEl("span", "dxpair"), alEl("label", "", "©"), alEl("span", "dxpair"));
  lines.children[1].append(cdInput("dxpo", C.pOwner, E.pOwner || t("Owner of the recording"), v => dxSet(A, { pOwner: v.trim() })), yr("dxpy", C.pYear, E.pYear, "pYear"));
  lines.children[3].append(cdInput("dxco", C.cOwner, E.cOwner || t("Owner of the artwork and text"), v => dxSet(A, { cOwner: v.trim() })), yr("dxcy", C.cYear, E.cYear, "cYear"));
  const parts = alEl("div", "cdhead dxhead");
  const party = (f, a, b) => {
    const p = C[f], w = alEl("span", "dxpair");
    w.append(cdInput("dx" + f + "n", p.name, a, v => dxSet(A, { [f]: Object.assign({}, p, { name: v.trim() }) })),
      cdInput("dx" + f + "d dxdpid" + (p.dpid && !DX_DPID.test(p.dpid) ? " bad" : ""), p.dpid, b, v => dxSet(A, { [f]: Object.assign({}, p, { dpid: v.trim().toUpperCase() }) })));
    return w;
  };
  parts.append(alEl("label", "", t("From")), party("sender", t("Your name or label"), "PADPIDA…"), alEl("label", "", t("To")), party("recipient", t("Distributor"), "PADPIDA…"));
  const right = alEl("div", "dxright");
  right.append(head, lines, parts);
  top.append(cov, right);
  box.appendChild(top);
  const deals = alEl("div", "cdbtns dxdeals");
  const tog = (f, label, title) => { const b = alBtn(label, title, () => dxSet(A, { [f]: !C[f] }), "outbtn dxtog dx" + f + (C[f] ? " on" : "")); b.setAttribute("aria-pressed", C[f] ? "true" : "false"); return b; };
  deals.append(tog("stream", t("Streaming"), t("Subscription and ad-supported streaming, worldwide")), tog("download", t("Download"), t("Paid download, worldwide")), tog("test", t("Test delivery"), t("Marks the message as a test, for the distributor's first check")));
  box.appendChild(deals);
  const tbl = alEl("div", "dxtbl");
  tbl.append(alEl("span", "cdh", "#"), alEl("span", "cdh", t("Title")), alEl("span", "cdh", "ISRC"), alEl("span", "cdh", t("Length")), alEl("span", "cdh", t("Composers")), alEl("span", "cdh", t("Lyricists")), alEl("span", "cdh", "E"));
  L.forEach((k, i) => {
    const c = k.cd || {}, id = k.id;
    const set = (f, v) => cdEdit(A, s2 => { const q = cdClips(s2).find(x => x.id === id); if (q) q.cd = Object.assign({ title: "", performer: "", isrc: "" }, q.cd || {}, { [f]: v }); });
    const ex = alBtn("E", t("Explicit lyrics"), () => set("explicit", !c.explicit), "outbtn dxex" + (c.explicit ? " on" : ""));
    ex.setAttribute("aria-pressed", c.explicit ? "true" : "false");
    tbl.append(alEl("span", "cdn", String(i + 1)), alEl("span", "dxt", c.title || k.name), alEl("span", "cdtm" + (c.isrc ? "" : " dxmiss"), c.isrc || "—"), alEl("span", "cdtm", fmtDur(durs[i])),
      cdInput("dxcomp", c.composer || "", "Jo Doe, Ann Lee", v => set("composer", dxNames(v).join(", "))), cdInput("dxlyr", c.lyricist || "", C.lang === "zxx" ? "" : "Jo Doe, Ann Lee", v => set("lyricist", dxNames(v).join(", "))), ex);
  });
  box.appendChild(tbl);
  const chk = alEl("div", "cdchk");
  for (const r of dxCheck(A, s, src)) chk.appendChild(alEl("div", r.good ? "ok" : "bad", (r.good ? "✓ " : "⚠ ") + r.text));
  box.appendChild(chk);
  const btns = alEl("div", "cdbtns");
  const go = alBtn(t("Make the DDEX package"), t("Renders every track as FLAC with MD5 checksums and writes the ERN 4.3 XML and the cover into one zip"), () => dxPackage(A), "outbtn dxgo");
  go.disabled = !!dx.job;
  btns.appendChild(go);
  box.appendChild(btns);
  const bar = alEl("div", "dxbar" + (dx.job ? "" : " hidden"));
  bar.append(alEl("div", "dxfill"), alEl("span", "snote dxstep", dx.job ? dx.job.step : ""));
  box.appendChild(bar);
  dxProg();
}

function dxProg() {
  const bar = document.querySelector("#albDdex .dxbar");
  if (!bar) return;
  const J = dx.job;
  bar.classList.toggle("hidden", !J);
  if (!J) return;
  bar.querySelector(".dxfill").style.width = Math.round(Math.min(1, J.frac) * 100) + "%";
  bar.querySelector(".dxstep").textContent = J.step;
}

function dxJob(m) {
  const J = dx.job;
  if (!J || !J.x || m.id !== J.x.id) return false;
  if (m.state === "rendering" || m.state === "hashing") { J.frac = 0.9 * (J.x.i + (m.state === "rendering" ? 0.85 * (m.frac || 0) : 0.85 + 0.15 * (m.frac || 0))) / J.x.n; dxProg(); }
  if (m.state === "done") J.x.res(m);
  if (m.state === "failed" || m.state === "cancelled") J.x.rej(new Error(m.error || m.state));
  return true;
}

function dxZipProg(m) {
  const J = dx.job;
  if (!J || m.jobId !== J.zip) return;
  J.frac = 0.9 + 0.1 * (m.frac || 0);
  dxProg();
}

async function dxPackage(A) {
  if (dx.job) return;
  const s0 = await cdSession(A);
  if (!s0) return;
  const src = await sqSources(A, s0), bad = dxCheck(A, s0, src).filter(r => !r.good && !r.soft);
  if (bad.length) { tell(bad.map(r => "⚠ " + r.text).join("\n"), t("Fix these before making the DDEX package")); return; }
  const cover = await dxCoverBytes(A);
  if (!cover) { tell(t("Choose the cover again: the file is no longer here."), t("Could not make the DDEX package")); return; }
  const M = await cdMixdown(A);
  if (!M) return;
  await alOpen(A.id);
  const C = dxCfg(A), E = dxEff(C), { pieces, P, T, upc } = cdCut(A, M), hi = dxHires(src), sr = M.info.sampleRate;
  const fmt = hi ? { type: "flac", bits: 24, rate: 0 } : { type: "flac", bits: 16, rate: 44100 }, fmtLabel = hi ? "FLAC 24-bit/" + (sr / 1000).toLocaleString(i18n.lang || undefined) + " kHz" : "FLAC 16-bit/44.1 kHz";
  const J = dx.job = { frac: 0, step: "", x: null, zip: "" }, made = [];
  const renderAll = () => { if (al.cur) alRenderCd(al.cur); };
  renderAll();
  try {
    for (const [i, p] of pieces.entries()) {
      const name = upc + "_01_" + String(i + 1).padStart(3, "0") + ".flac", xid = "dx" + Date.now().toString(36) + i;
      J.step = t("Track {i} of {n}").replace("{i}", i + 1).replace("{n}", pieces.length);
      J.x = { id: xid, i, n: pieces.length };
      const done = new Promise((res, rej) => { J.x.res = res; J.x.rej = rej; });
      dxProg();
      await call({ t: "export", id: M.info.id, jobId: xid, a: p.a, b: p.b, name, fmt, master: { gain: 0, dither: "tpdf", shaping: "off" }, dest: { kind: "ddex" }, tags: xpTags(p), pic: null, marks: [] });
      const r = await done;
      made.push({ name, file: r.file, md5: r.md5, size: r.size, rate: r.rate, bits: r.bits, dur: (p.b - p.a) / sr, p });
      J.frac = 0.9 * (i + 1) / pieces.length;
    }
    J.x = null;
    const ext = C.cover.mime === "image/png" ? "png" : "jpg", coverName = upc + "." + ext;
    const R = {
      id: "DS-" + upc + "-" + Date.now(), created: new Date().toISOString().replace(/\.\d+Z$/, "Z"), sender: C.sender, recipient: C.recipient, test: C.test,
      upc, catno: C.catno, title: T, artist: P, label: C.label, genre: C.genre, date: C.date, pYear: E.pYear, pOwner: E.pOwner, cYear: E.cYear, cOwner: E.cOwner,
      lang: C.lang, type: C.type || dxType(made.map(m => m.dur)), hires: hi, stream: C.stream, download: C.download,
      tracks: made.map(m => { const c = m.p.clip.cd || {}; return { isrc: c.isrc, title: m.p.tag.title, artist: c.performer && c.performer !== P ? c.performer : "", dur: m.dur, file: "resources/" + m.name, md5: m.md5, size: m.size, rate: m.rate, bits: m.bits, explicit: !!c.explicit, composers: dxNames(c.composer), lyricists: dxNames(c.lyricist) }; }),
      cover: { file: "resources/" + coverName, md5: ddpMd5(cover), size: cover.length, w: C.cover.w, h: C.cover.h, codec: ext === "png" ? "PNG" : "JPEG" }
    };
    const xml = new TextEncoder().encode(dxXml(R));
    J.step = t("Writing the zip");
    J.zip = "z" + Date.now().toString(36);
    dxProg();
    const items = [{ name: upc + "/" + upc + ".xml", bytes: xml }].concat(made.map(m => ({ name: upc + "/resources/" + m.name, file: m.file, size: m.size, drop: true })), [{ name: upc + "/resources/" + coverName, bytes: cover }]);
    const z = await call({ t: "dxzip", jobId: J.zip, items });
    made.length = 0;
    const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("studio")).getDirectoryHandle("exports");
    const f = await (await dir.getFileHandle(z.file)).getFile(), url = URL.createObjectURL(f), a = document.createElement("a");
    a.href = url;
    a.download = upc + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 600000);
    dx.last = { xml: dxXml(R), zip: z.file, size: z.size };
    flash(t("DDEX package written: {n} tracks, {f}, {s}").replace("{n}", R.tracks.length).replace("{f}", fmtLabel).replace("{s}", fmtBytes(z.size)));
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (msg !== "cancelled") tell(msg === "too-large" ? t("The package is larger than 4 GB, too large for one zip.") : msg, t("Could not make the DDEX package"));
  } finally {
    if (made.length) { try { const dir = await (await (await navigator.storage.getDirectory()).getDirectoryHandle("studio")).getDirectoryHandle("exports"); for (const m of made) { try { await dir.removeEntry(m.file); } catch {} } } catch {} }
    dx.job = null;
    renderAll();
  }
}

if (typeof module !== "undefined") module.exports = { dxXml, dxDur, dxType, dxEsc, dxNames, DX_DPID };

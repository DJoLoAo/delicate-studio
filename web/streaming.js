const SQ_SERVICES = [
  { v: "spotify", label: "Spotify", lufs: -14, mode: "peak", album: true, sv: "spotify", lossy: true, best: "FLAC up to 24-bit/44.1 kHz (Premium), Ogg Vorbis otherwise" },
  { v: "apple", label: "Apple Music", lufs: -16, mode: "down", album: false, sv: "apple", lossy: true, best: "ALAC up to 24-bit/192 kHz, AAC 256 kbps otherwise" },
  { v: "youtube", label: "YouTube", lufs: -14, mode: "down", album: false, sv: "youtube", lossy: true, best: "Opus or AAC, lossy only" },
  { v: "tidal", label: "TIDAL", lufs: -14, mode: "peak", album: true, sv: "", lossy: false, best: "FLAC up to 24-bit/192 kHz" },
  { v: "amazon", label: "Amazon Music", lufs: -14, mode: "peak", album: false, sv: "", lossy: false, best: "FLAC up to 24-bit/192 kHz (Ultra HD)" },
  { v: "deezer", label: "Deezer", lufs: -15, mode: "peak", album: false, sv: "deezer", lossy: true, best: "FLAC up to 24-bit/192 kHz for subscribers, MP3 on Deezer Free" },
  { v: "qobuz", label: "Qobuz", lufs: null, mode: "none", album: true, sv: "", lossy: false, best: "FLAC up to 24-bit/192 kHz" },
  { v: "soundcloud", label: "SoundCloud", lufs: -14, mode: "peak", album: false, sv: "soundcloud", lossy: true, best: "Opus or AAC, lossy only" }
];

function sqLevel(p, l, tp) {
  if (l === null || l === undefined) return null;
  if (p.mode === "none") return { gain: 0, after: tp };
  const r = repPlat({ integrated: l, chans: [{ tp }] }, { lufs: p.lufs, mode: p.mode });
  return { gain: r.gain, after: r.after };
}

function sqRows(A, s) {
  const M = cdMeas(A, s);
  if (!M) return null;
  return SQ_SERVICES.map(p => {
    const tr = M.tracks.map(k => sqLevel(p, k.lufs, k.tp)).filter(Boolean);
    const al = p.album ? sqLevel(p, M.album.lufs, M.album.tp) : null;
    const gains = tr.map(x => x.gain), afters = tr.map(x => x.after).filter(v => v !== null && v !== undefined);
    const pks = afters.concat(al && M.album.tp !== null ? [M.album.tp + al.gain] : []);
    const peak = pks.length ? Math.max(...pks) : null;
    return { p, album: al ? al.gain : null, lo: gains.length ? Math.min(...gains) : null, hi: gains.length ? Math.max(...gains) : null, peak, hot: p.lossy && peak !== null && peak > -1 };
  });
}

function sqGain(v) { return v === null ? "—" : Math.abs(v) < 0.05 ? t("as it is") : repDb(v, "dB"); }

function sqSpan(lo, hi) {
  if (lo === null) return "—";
  if (Math.abs(hi - lo) < 0.15) return sqGain(lo);
  return repDb(lo, "") + " … " + repDb(hi, "dB");
}

const sqR = { n: 0 };
const SQ_LOSSY = /\.(mp3|m4a|aac|ogg|oga|opus|webm|mp4)$/i;

async function sqSources(A, s) {
  const ids = [...new Set(cdClips(s).map(k => k.doc))];
  let docs = [];
  try { docs = (await call({ t: "docinfo", ids })).docs.filter(d => !d.error); } catch {}
  if (!docs.length) return null;
  const bits = Math.min(...docs.map(d => d.bits || 16)), sr = Math.min(...docs.map(d => d.sampleRate)), lossy = docs.filter(d => SQ_LOSSY.test(d.name)).map(d => d.name);
  return { bits, sr, lossy, rate: s.sr || sr, n: docs.length };
}

function sqBadges(src) {
  const hi = src.bits >= 24 && !src.lossy.length, k = v => (v / 1000).toLocaleString(i18n.lang || undefined) + " kHz";
  const out = [];
  if (src.lossy.length) out.push({ good: false, text: t("Made from lossy files ({f}): no lossless or hi-res label is honest for this release.").replace("{f}", src.lossy.slice(0, 3).join(", ") + (src.lossy.length > 3 ? " …" : "")) });
  else if (!hi) out.push({ good: false, text: t("The sources are 16-bit: deliver CD quality. A 24-bit file of 16-bit material gets no hi-res label.") });
  else {
    out.push({ good: true, text: t("Sources {b} at {r} or more: the hi-res master qualifies on Qobuz (Hi-Res), Amazon Music (Ultra HD), TIDAL (Max) and Deezer.").replace("{b}", src.bits >= 32 ? "32-bit float" : src.bits + "-bit").replace("{r}", k(src.sr)) });
    out.push({ good: src.rate > 48000, text: src.rate > 48000 ? t("Apple Music shows Hi-Res Lossless (above 48 kHz).") : t("Apple Music shows Lossless; Hi-Res Lossless needs more than 48 kHz.") });
    if (src.rate > 44100) out.push({ good: true, text: t("Spotify plays at most 24-bit/44.1 kHz and converts it itself.") });
  }
  out.push({ good: true, text: t("Every track of a release needs the hi-res specs for the badge; the lowest source counts.") });
  return out;
}

function sqDeliver(A, src) {
  const f = [{ type: "wav", bits: 16, rate: 44100 }];
  if (src && src.bits >= 24 && !src.lossy.length) f.unshift({ type: "flac", bits: 24, rate: 0 });
  cdRelease(A, { formats: f });
}

async function sqHear(A, plat) {
  await cdRelease(A, { hear: plat });
}

async function alRenderSq(A) {
  const box = $("albStream");
  if (!box) return;
  const n = ++sqR.n;
  const s = await cdSession(A);
  if (al.cur !== A || n !== sqR.n) return;
  box.textContent = "";
  if (!s) { box.appendChild(alEl("div", "snote", t("Make the montage in the CD section first; the services are judged from it."))); return; }
  const rows = sqRows(A, s);
  if (!rows) {
    box.appendChild(alEl("div", "snote", t("Measure the montage's loudness to see how each service will play the album.")));
    const b = alBtn(t("Measure"), t("Integrated loudness and true peak of every track and of the whole album"), () => cdMeasure(A), "outbtn sqmeas");
    b.disabled = !!cd.lm;
    box.appendChild(b);
    await sqHiresBox(A, s, box, n);
    return;
  }
  const tbl = alEl("div", "sqtbl");
  tbl.append(alEl("span", "cdh", t("Service")), alEl("span", "cdh", t("The album")), alEl("span", "cdh", t("In a playlist")), alEl("span", "cdh", t("Peak then")), alEl("span", "cdh", t("Best quality")), alEl("span", "cdh", ""));
  for (const r of rows) {
    const pk = alEl("span", "cdtm" + (r.hot ? " sqhot" : ""), r.peak === null ? "—" : repDb(r.peak, "dBTP"));
    if (r.hot) pk.title = t("Above −1 dBTP: the lossy stream can distort. Lower the true-peak ceiling of the master.");
    const hear = r.p.sv ? alBtn(t("hear"), t("Hear the release mix as {p} plays it, in the Streaming preview").replace("{p}", r.p.label), () => sqHear(A, r.p.sv), "outbtn sqhear") : alEl("span", "");
    tbl.append(alEl("span", "sqn", r.p.label + (r.p.lufs === null ? "" : " · " + r.p.lufs + " LUFS")), alEl("span", "cdtm", r.album === null ? t("track by track") : sqGain(r.album)), alEl("span", "cdtm", sqSpan(r.lo, r.hi)), pk, alEl("span", "snote", t(r.p.best)), hear);
  }
  box.appendChild(tbl);
  const hot = rows.filter(r => r.hot).map(r => r.p.label);
  const chk = alEl("div", "cdchk");
  chk.appendChild(alEl("div", hot.length ? "bad" : "ok", hot.length ? "⚠ " + t("Peaks above −1 dBTP after the level change on {s}: lower the true-peak ceiling to −1 dBTP, or −2 for loud masters.").replace("{s}", hot.join(", ")) : "✓ " + t("Peaks stay below −1 dBTP on every service")));
  chk.appendChild(alEl("div", "ok", "ℹ " + t("Spotify and TIDAL keep the level differences between the songs when the album plays; in playlists and on the other services every track is levelled on its own. Qobuz does not level by default.")));
  box.appendChild(chk);
  await sqHiresBox(A, s, box, n);
}

async function sqHiresBox(A, s, box, n) {
  const src = await sqSources(A, s);
  if (al.cur !== A || !src || n !== sqR.n) return;
  const hb = alEl("div", "cdchk sqhires");
  for (const r of sqBadges(src)) hb.appendChild(alEl("div", r.good ? "ok" : "bad", (r.good ? "✓ " : "⚠ ") + r.text));
  box.appendChild(hb);
  const two = src.bits >= 24 && !src.lossy.length;
  const rate = (src.rate / 1000).toLocaleString(i18n.lang || undefined);
  const btns = alEl("div", "cdbtns");
  btns.appendChild(alBtn(two ? t("Export hi-res and CD quality") : t("Export CD quality"), two ? t("FLAC 24-bit at {r} kHz for the hi-res services and WAV 16-bit/44.1 kHz with dither for the others, one file per track with tags").replace("{r}", rate) : t("WAV 16-bit/44.1 kHz with dither, one file per track with tags"), () => sqDeliver(A, src), "outbtn sqdeliver"));
  box.appendChild(btns);
}

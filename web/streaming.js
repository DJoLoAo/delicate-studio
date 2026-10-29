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

async function sqHear(A, plat) {
  await cdRelease(A, { hear: plat });
}

async function alRenderSq(A) {
  const box = $("albStream");
  if (!box) return;
  const s = await cdSession(A);
  if (al.cur !== A) return;
  box.textContent = "";
  if (!s) { box.appendChild(alEl("div", "snote", t("Make the montage in the CD section first; the services are judged from it."))); return; }
  const rows = sqRows(A, s);
  if (!rows) {
    box.appendChild(alEl("div", "snote", t("Measure the montage's loudness to see how each service will play the album.")));
    const b = alBtn(t("Measure"), t("Integrated loudness and true peak of every track and of the whole album"), () => cdMeasure(A), "outbtn sqmeas");
    b.disabled = !!cd.lm;
    box.appendChild(b);
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
}

const vn = { res: {}, job: null, side: "" };
const VN_FMT = {
  "12-33": { label: "12\" 33⅓", ok: 18 * 60, max: 22 * 60 },
  "12-45": { label: "12\" 45", ok: 12 * 60, max: 15 * 60 },
  "10-33": { label: "10\" 33⅓", ok: 12 * 60, max: 15 * 60 },
  "10-45": { label: "10\" 45", ok: 9 * 60, max: 11 * 60 },
  "7-45": { label: "7\" 45", ok: 4.5 * 60, max: 5.5 * 60 },
  "7-33": { label: "7\" 33⅓", ok: 6 * 60, max: 7 * 60 }
};

function vnFmt(A) { return VN_FMT[A.vinyl && A.vinyl.fmt] ? A.vinyl.fmt : "12-33"; }

function vnT(sec) { const s = Math.max(0, Math.round(sec)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }

function vnSig(d) { return d.frames + "/" + d.edits; }

function vnRanges(d) { return (d.marks || []).filter(m => m.kind === "range").sort((x, y) => x.a - y.a); }

function vnRes(d) { const R = vn.res[d.id]; return R && R.sig === vnSig(d) ? R.r : null; }

async function vnRun(A) {
  if (vn.job) return;
  await alInfos(A);
  const ids = A.sides.filter(id => al.infos[id] && !al.infos[id].error);
  if (!ids.length) return;
  vn.job = { id: "v" + Date.now() };
  if (al.cur) alRenderVn(al.cur);
  try {
    for (const id of ids) {
      const d = al.infos[id];
      vn.side = d.name;
      const r = await call({ t: "vncheck", jobId: vn.job.id, id, tracks: vnRanges(d).map(m => [m.a, m.b]) });
      vn.res[id] = { sig: vnSig(d), r };
    }
  } catch (e) { if ((e && e.message) !== "cancelled") tell(String(e.message || e), t("Could not check the sides")); }
  finally { vn.job = null; vn.side = ""; if (al.cur) alRenderVn(al.cur); }
}

function vnProg(m) {
  if (!vn.job || m.id !== vn.job.id) return false;
  const e = document.querySelector("#albVinyl .vnprog");
  if (e) e.textContent = t("Checking") + " " + vn.side + " · " + Math.round(m.frac * 100) + " %";
  return true;
}

async function vnJump(id, a, b) {
  alHide();
  await openDoc(id);
  if (!ed.doc || ed.doc.id !== id) return;
  ed.sel = { a, b };
  ed.cursor = a;
  ensureVisible(a);
  redraw();
}

function vnLine(box, good, text, spots, d) {
  const row = alEl("div", good ? "ok" : "bad");
  row.appendChild(alEl("span", "", (good ? "✓ " : "⚠ ") + text));
  if (spots && spots.length) {
    const s = alEl("span", "vnspots");
    for (const p of spots) {
      const b = alEl("button", "vnt", vnT(p.a / d.sampleRate));
      b.type = "button";
      b.title = t("Open the side there");
      b.addEventListener("click", () => vnJump(d.id, p.a, p.b));
      s.appendChild(b);
    }
    row.appendChild(s);
  }
  box.appendChild(row);
}

function vnSide(A, d, letter) {
  const F = VN_FMT[vnFmt(A)], len = d.frames / d.sampleRate, box = alEl("div", "vnside");
  box.appendChild(alEl("div", "vnh", t("Side") + " " + letter + " · " + d.name + " · " + vnT(len)));
  const chk = alEl("div", "cdchk");
  if (len <= F.ok) vnLine(chk, true, t("{t} fits a {f} side").replace("{t}", vnT(len)).replace("{f}", F.label));
  else if (len <= F.max) vnLine(chk, false, t("{t} is long for a {f} side: expect a lower level and less bass (up to {ok} is comfortable)").replace("{t}", vnT(len)).replace("{f}", F.label).replace("{ok}", vnT(F.ok)));
  else vnLine(chk, false, t("{t} is longer than a {f} side usually holds ({max})").replace("{t}", vnT(len)).replace("{f}", F.label).replace("{max}", vnT(F.max)));
  const r = vnRes(d);
  if (!r) { box.appendChild(chk); return box; }
  if (r.clip) vnLine(chk, false, t("{n} samples at full scale: the cut needs headroom, leave the peaks lower").replace("{n}", r.clip));
  else vnLine(chk, true, t("Peak {p} dBFS").replace("{p}", r.peak === null ? "—" : r.peak.toFixed(1)));
  const dc = Math.max(...r.dc.map(Math.abs));
  vnLine(chk, dc < 0.002, dc < 0.002 ? t("No DC offset") : t("DC offset of {v} %: remove it before the cut").replace("{v}", (dc * 100).toFixed(2)));
  if (r.ch >= 2) {
    vnLine(chk, !r.phase.length, r.phase.length ? t("Bass out of phase (below 150 Hz): the groove gets too deep and the stylus can jump") : t("Bass in phase"), r.phase, d);
    if (r.wide.length) vnLine(chk, false, t("Wide bass (below 150 Hz): cutting engineers usually make the bass mono here"), r.wide, d);
    if (r.corr < 0.3) vnLine(chk, false, t("Very wide stereo overall (correlation {c}): check it in mono").replace("{c}", r.corr.toFixed(2)));
  }
  vnLine(chk, !r.hot.length, r.hot.length ? t("Hot highs above 8 kHz: sibilance and cymbals can distort, worst near the label") : t("Highs within reach of the cutter"), r.hot, d);
  const T = r.tracks.filter(k => k.hf !== null && k.rms !== null);
  if (T.length >= 2) {
    const last = T[T.length - 1], rest = T.slice(0, -1), hf = Math.max(...rest.map(k => k.hf)), rms = Math.max(...rest.map(k => k.rms));
    const bad = last.hf >= hf - 1 || last.rms >= rms - 1;
    vnLine(chk, !bad, bad ? t("The last track is among the loudest or brightest of the side; the inner groove distorts more, consider putting a quieter one there") : t("A quieter track at the end of the side, good for the inner groove"));
  }
  box.appendChild(chk);
  return box;
}

function alRenderVn(A) {
  const box = $("albVinyl");
  if (!box) return;
  box.textContent = "";
  const row = alEl("div", "cdlrow");
  const dd = alEl("div", "dd down vnf");
  dd.innerHTML = '<div class="cur"></div><div class="list"></div>';
  ddInit(dd, Object.keys(VN_FMT).map(k => ({ v: k, label: VN_FMT[k].label })), vnFmt(A), async v => {
    const C = al.cur;
    if (!C) return;
    C.vinyl = { fmt: v };
    await alSave();
    if (al.cur) alRenderVn(al.cur);
  });
  const go = alBtn(vn.job ? t("Checking…") : t("Check for vinyl"), t("Side lengths, peaks, DC, bass phase and width below 150 Hz, highs above 8 kHz and the inner groove of every side"), () => vnRun(A), "outbtn vngo");
  go.disabled = !!vn.job || !A.sides.length;
  row.append(alEl("label", "", t("Format")), dd, go);
  box.appendChild(row);
  const pr = alEl("div", "snote vnprog", vn.job ? t("Checking…") : "");
  box.appendChild(pr);
  const letters = alLetters(A);
  let any = false;
  A.sides.forEach((id, i) => {
    const d = al.infos[id];
    if (!d || d.error) return;
    any = true;
    box.appendChild(vnSide(A, d, letters[i]));
  });
  if (!any) box.appendChild(alEl("div", "snote", t("Add the sides of the record to check them for the vinyl cut.")));
  else if (!A.sides.some(id => al.infos[id] && vnRes(al.infos[id]))) box.appendChild(alEl("div", "snote", t("Check for vinyl measures every side the way a cutting engineer listens: bass phase and width, hot highs, peaks and the inner groove.")));
}

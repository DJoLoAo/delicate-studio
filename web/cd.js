const cd = { trans: null, timer: 0, ddp: null };
const CD_GAP = 2, CD_PREGAP = 2, CD_MAXF = (79 * 60 + 57) * 75 + 74;

function cdSnap(x, sr) { const f = sr / 75; return Math.max(0, Math.round(Math.round(x / f) * f)); }

function cdTime(x, sr) {
  const f = Math.round(x / sr * 75), m = Math.floor(f / 4500), s = Math.floor(f / 75) % 60, r = f % 75, p = v => String(v).padStart(2, "0");
  return p(m) + ":" + p(s) + ":" + p(r);
}

function cdIsrcOk(v) { return /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(v); }

function cdUpcOk(v) {
  if (!/^\d{12,13}$/.test(v)) return false;
  const d = (v.length === 12 ? "0" + v : v).split("").map(Number);
  let s = 0;
  for (let i = 0; i < 12; i++) s += d[i] * (i % 2 ? 3 : 1);
  return (10 - s % 10) % 10 === d[12];
}

function cdClips(s) { return s && s.tracks[0] ? s.tracks[0].clips.slice().sort((a, b) => a.at - b.at) : []; }

async function cdSession(A) {
  if (!A || !A.montage) return null;
  if (ses.open && ses.s && ses.s.id === A.montage) return ses.s;
  try { return (await call({ t: "sesget", id: A.montage })).s; } catch { return null; }
}

async function cdWrite(s) {
  if (ses.open && ses.s && ses.s.id === s.id) { ssCommit(); return; }
  await call({ t: "sesput", s });
}

async function cdMake(A, rebuild) {
  if (rebuild && ses.open && ses.s && ses.s.id === A.montage) await ssClose(true);
  await alInfos(A);
  const letters = alLetters(A), items = [], skipped = [];
  A.sides.forEach((id, i) => {
    const d = al.infos[id];
    if (!d || d.error) return;
    const ranges = (d.marks || []).filter(m => m.kind === "range").sort((x, y) => x.a - y.a), side = { letter: letters[i], disc: Math.floor(i / 2) + 1 };
    if (!ranges.length) { items.push({ doc: id, from: 0, len: d.frames, sr: d.sampleRate, name: d.name, cd: { title: d.name.replace(/\.[^.]+$/, ""), performer: alArtist(A), isrc: "" } }); return; }
    ranges.forEach((m, j) => {
      const g = alTag(m, side, j, A);
      items.push({ doc: id, from: m.a, len: m.b - m.a, sr: d.sampleRate, name: g.pos + " " + g.title, cd: { title: g.title, performer: g.artist || alArtist(A), isrc: String(g.isrc || "").toUpperCase().replace(/[^A-Z0-9]/g, "") } });
    });
  });
  if (!items.length) { tell(t("Add the files of this record first: each range marker on a side becomes a track of the CD.")); return; }
  const sr = items[0].sr, clips = [];
  let at = 0;
  for (const it of items) {
    if (it.sr !== sr) { skipped.push(it.name); continue; }
    at = cdSnap(at, sr);
    clips.push({ id: ssNewId(), doc: it.doc, at, from: it.from, len: it.len, gain: 0, fin: 0, fout: 0, name: it.name, cd: it.cd });
    at += it.len + CD_GAP * sr;
  }
  const track = { id: ssNewId(), name: t("Album"), gain: 0, pan: 0, mute: false, solo: false, clips };
  let s = rebuild ? await cdSession(A) : null;
  if (s) {
    s.tracks = [Object.assign(s.tracks[0] || track, { clips })].concat(s.tracks.slice(1));
    s.sr = sr;
    await cdWrite(s);
  } else {
    s = (await call({ t: "sesnew", name: (alTitle(A) + " · " + t("montage")).slice(0, 160), sr, tracks: [track], marks: [], src: { kind: "album", rec: A.id } })).s;
    A.montage = s.id;
  }
  if (!A.cd || typeof A.cd !== "object") A.cd = { upc: "", title: "", performer: "" };
  if (!A.cd.title) A.cd.title = alTitle(A);
  if (!A.cd.performer) A.cd.performer = alArtist(A);
  await alChanged();
  flash(t("{n} tracks in the montage, 2 s apart").replace("{n}", clips.length) + (skipped.length ? " · " + t("left out at another rate") + ": " + skipped.join(", ") : ""));
}

function cdCheck(A, s) {
  const sr = s.sr || 44100, L = cdClips(s), out = [], ok = (good, text) => out.push({ good, text });
  if (!L.length) { ok(false, t("The montage has no tracks.")); return out; }
  ok(L.length <= 99, L.length <= 99 ? t("{n} tracks").replace("{n}", L.length) : t("A CD holds at most 99 tracks."));
  const short = L.filter((k, i) => (i + 1 < L.length ? L[i + 1].at - k.at : k.len) < sr * 4);
  ok(!short.length, short.length ? t("Shorter than 4 s, too short for a CD track") + ": " + short.map(k => (k.cd && k.cd.title) || k.name).join(", ") : t("Every track is at least 4 s long"));
  const total = CD_PREGAP * sr + Math.max(...L.map(k => k.at + k.len)) - L[0].at, tf = Math.round(total / sr * 75);
  out.push({ good: tf <= CD_MAXF, soft: true, text: (tf <= CD_MAXF ? t("Total {t}, fits on a CD") : t("Total {t}, longer than a CD (79:57:74)")).replace("{t}", cdTime(total, sr)) });
  const isrc = L.map(k => (k.cd && k.cd.isrc) || ""), bad = isrc.filter(v => v && !cdIsrcOk(v)), dup = isrc.filter((v, i) => v && isrc.indexOf(v) !== i);
  if (bad.length) ok(false, t("ISRC not in the form CC-XXX-YY-NNNNN") + ": " + bad.join(", "));
  else if (dup.length) ok(false, t("The same ISRC on two tracks") + ": " + [...new Set(dup)].join(", "));
  else ok(true, isrc.every(Boolean) ? t("ISRC on every track") : t("ISRC on {n} of {m} tracks").replace("{n}", isrc.filter(Boolean).length).replace("{m}", L.length));
  const upc = (A.cd && A.cd.upc) || "";
  ok(!upc || cdUpcOk(upc), !upc ? t("No UPC/EAN") : cdUpcOk(upc) ? t("UPC/EAN checks out") : t("UPC/EAN check digit is wrong"));
  out.push({ good: !!(A.cd && A.cd.title && L.every(k => k.cd && k.cd.title)), text: t("CD-Text for the album and every track"), soft: true });
  const packs = (cdText(A, L) || []).length / 18;
  if (packs > 256) ok(false, t("Too much CD-Text: shorten the titles and names"));
  if (sr !== 44100) ok(true, t("Made at {r} kHz; the DDP is written at 44.1 kHz, 16-bit").replace("{r}", (sr / 1000).toLocaleString()));
  return out;
}

function cdTracks(A, L) {
  const P = (A.cd && A.cd.performer) || alArtist(A) || "";
  return L.map(k => ({ at: k.at, isrc: (k.cd && k.cd.isrc) || "", title: (k.cd && k.cd.title) || k.name || "", performer: (k.cd && k.cd.performer) || P }));
}

function cdText(A, L) {
  if (!L.length) return null;
  return ddpCdText({ title: (A.cd && A.cd.title) || alTitle(A) || "", performer: (A.cd && A.cd.performer) || alArtist(A) || "" }, cdTracks(A, L));
}

function cdBase(A) { return (((A.cd && A.cd.title) || alTitle(A) || "CD").replace(/[\\/:*?"<>|]+/g, "-").trim().slice(0, 60) || "CD") + " DDP"; }

async function cdDdp(A) {
  const s0 = await cdSession(A);
  if (!s0) return;
  const bad = cdCheck(A, s0).filter(r => !r.good && !r.soft);
  if (bad.length) { tell(bad.map(r => "⚠ " + r.text).join("\n"), t("Fix these before writing the DDP")); return; }
  const sr0 = s0.sr || 44100, L0 = cdClips(s0), end0 = Math.max(...L0.map(k => k.at + k.len)), tf = Math.round((CD_PREGAP * sr0 + end0 - L0[0].at) / sr0 * 75);
  if (tf > (99 * 60 + 59) * 75 + 74) { tell(t("The program is longer than 99:59:74 and cannot be written as a DDP."), t("Could not write the DDP")); return; }
  if (tf > CD_MAXF && !(await ask(t("Longer than a CD"), t("The program is longer than 79:57:74. Not every plant presses that much; ask yours first."), { ok: t("Write the DDP") }))) return;
  await cdOpen(A);
  if (!ses.open || ses.s.id !== A.montage) return;
  await ssSave();
  const s = ses.s, L = cdClips(s), end = Math.max(...L.map(k => k.at + k.len)), jobId = "d" + Date.now();
  cd.ddp = { id: jobId };
  let r;
  try {
    r = await call({ t: "cdddp", jobId, a: L[0].at, b: end, tracks: cdTracks(A, L), title: (A.cd && A.cd.title) || alTitle(A) || "", performer: (A.cd && A.cd.performer) || alArtist(A) || "", upc: (A.cd && A.cd.upc) || "", folder: cdBase(A), cdtext: true, head: ["Delicate Studio · " + new Date().toISOString().slice(0, 10)] });
  } catch (e) { if ((e && e.message) !== "cancelled") tell(String(e.message || e), t("Could not write the DDP")); return; }
  finally { cd.ddp = null; $("stMsg").textContent = ""; }
  try {
    const root = await navigator.storage.getDirectory(), dir = await (await root.getDirectoryHandle("studio")).getDirectoryHandle("exports");
    const f = await (await dir.getFileHandle(r.file)).getFile(), url = URL.createObjectURL(f), a = document.createElement("a");
    a.href = url;
    a.download = cdBase(A) + ".zip";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 600000);
  } catch { tell(t("The rendered file is no longer here. Render it again."), t("Could not write the DDP")); return; }
  const msg = t("DDP written: {n} tracks, {t}, 44.1 kHz 16-bit, with PQ list, cue sheet and MD5 checksums").replace("{n}", L.length).replace("{t}", cdTime(r.sectors / 75 * 44100, 44100));
  if (r.clipped) tell(msg + "\n\n" + t("{n} samples went over full scale and were clipped. Turn the montage down, or use a limiter, and write it again.").replace("{n}", r.clipped), t("DDP written with clipping"));
  else flash(msg);
}

function cdGaps(L) { return L.map((k, i) => i ? k.at - (L[i - 1].at + L[i - 1].len) : 0); }

function cdRelayout(s, gaps) {
  const L = cdClips(s), sr = s.sr || 44100;
  for (let i = 1; i < L.length; i++) {
    const g = Math.max(-Math.floor(Math.min(L[i - 1].len, L[i].len) / 2), gaps[i]);
    L[i].at = cdSnap(Math.max(0, L[i - 1].at + L[i - 1].len + g), sr);
  }
}

async function cdEdit(A, fn) {
  const s = await cdSession(A);
  if (!s) return;
  fn(s);
  await cdWrite(s);
  if (al.cur) alRenderCd(al.cur);
}

function cdInput(cls, value, ph, onChange) {
  const i = alEl("input", "xtext " + cls);
  i.value = value || "";
  if (ph) i.placeholder = ph;
  i.spellcheck = false;
  i.autocomplete = "off";
  i.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); i.blur(); } e.stopPropagation(); });
  i.addEventListener("change", () => onChange(i.value));
  return i;
}

async function alRenderCd(A) {
  const box = $("albCd");
  if (!box) return;
  const s = await cdSession(A);
  if (al.cur !== A) return;
  box.textContent = "";
  if (!s) {
    if (A.montage) { A.montage = ""; await alSave(); }
    box.appendChild(alEl("div", "snote", t("Lay the tracks of all sides out in order for a CD or a digital release: gaps, crossfades, CD-Text, ISRC and a DDP for the pressing plant.")));
    box.appendChild(alBtn(t("Make the montage"), t("A session with every track of the album in order, 2 s apart"), () => cdMake(A, false)));
    return;
  }
  const sr = s.sr || 44100, L = cdClips(s), gaps = cdGaps(L);
  if (!A.cd) A.cd = { upc: "", title: "", performer: "" };
  const head = alEl("div", "cdhead");
  const save = async (f, v) => {
    const C = al.cur;
    if (!C) return;
    C.cd = Object.assign({ upc: "", title: "", performer: "" }, C.cd || {}, { [f]: v });
    await alSave();
    if (al.cur) alRenderCd(al.cur);
  };
  head.append(alEl("label", "", t("CD title")), cdInput("cdt", A.cd.title, alTitle(A), v => save("title", v.trim())),
    alEl("label", "", t("Performer")), cdInput("cdp", A.cd.performer, alArtist(A), v => save("performer", v.trim())),
    alEl("label", "", "UPC/EAN"), cdInput("cdu", A.cd.upc, "0123456789012", v => save("upc", v.replace(/\D/g, ""))));
  box.appendChild(head);
  const tbl = alEl("div", "cdtbl");
  tbl.append(alEl("span", "cdh", "#"), alEl("span", "cdh", t("Start")), alEl("span", "cdh", t("Length")), alEl("span", "cdh", t("Gap (s)")), alEl("span", "cdh", t("Title")), alEl("span", "cdh", t("Performer")), alEl("span", "cdh", "ISRC"));
  L.forEach((k, i) => {
    const c = k.cd || {}, id = k.id;
    const set = (f, v) => cdEdit(A, s2 => { const q = cdClips(s2).find(x => x.id === id); if (q) q.cd = Object.assign({ title: "", performer: "", isrc: "" }, q.cd || {}, { [f]: v }); });
    const gap = i ? cdInput("cdg", (gaps[i] / sr).toFixed(2), "", v => { const x = Number(String(v).replace(",", ".")); if (!Number.isFinite(x)) { alRenderCd(A); return; } cdEdit(A, s2 => { const g = cdGaps(cdClips(s2)); g[i] = Math.round(x * (s2.sr || 44100)); cdRelayout(s2, g); }); }) : alEl("span", "snote", t("pregap") + " 2.00");
    if (i && gaps[i] < 0) gap.classList.add("xf");
    const isrc = cdInput("cdi", c.isrc, "CCXXXYYNNNNN", v => { const x = v.toUpperCase().replace(/[^A-Z0-9]/g, ""); isrc.value = x; set("isrc", x); });
    if (c.isrc && !cdIsrcOk(c.isrc)) isrc.classList.add("bad");
    tbl.append(alEl("span", "cdn", String(i + 1)), alEl("span", "cdtm", cdTime(CD_PREGAP * sr + k.at - L[0].at, sr)), alEl("span", "cdtm", cdTime(k.len, sr)), gap,
      cdInput("cdtt", c.title, k.name, v => set("title", v.trim())), cdInput("cdpp", c.performer, A.cd.performer || alArtist(A), v => set("performer", v.trim())), isrc);
  });
  box.appendChild(tbl);
  const chk = alEl("div", "cdchk");
  for (const r of cdCheck(A, s)) chk.appendChild(alEl("div", r.good ? "ok" : "bad", (r.good ? "✓ " : "⚠ ") + r.text));
  box.appendChild(chk);
  const btns = alEl("div", "cdbtns");
  btns.append(alBtn(t("Open the montage"), t("Open it in the multitrack to move, trim and fade the tracks"), () => cdOpen(A)), alBtn(t("Play the transitions"), t("The last 10 s of each track into the first 5 s of the next"), () => cdTransitions(A)), alBtn(t("Write the DDP"), t("A DDP 2.0 fileset for the pressing plant, 44.1 kHz 16-bit, as a zip with PQ list, cue sheet and MD5 checksums"), () => cdDdp(A)), alBtn(t("Rebuild from the sides"), t("Lay the montage out again from the range markers of the sides"), async () => { if (await ask(t("Rebuild the montage?"), t("Gaps, crossfades and CD-Text of the montage are laid out again from the sides."), { ok: t("rebuild") })) cdMake(A, true); }));
  box.appendChild(btns);
}

async function cdOpen(A) {
  if (!A.montage) return;
  alHide();
  await ssOpen(A.montage);
  if (ses.open && ses.mode === "scenes") snMode("multi");
}

function cdTransStop() {
  clearInterval(cd.timer);
  cd.timer = 0;
  cd.trans = null;
}

async function cdTransitions(A) {
  await cdOpen(A);
  if (!ses.open || ses.s.id !== A.montage) return;
  const L = cdClips(ses.s), sr = ssRate(), list = [];
  for (let i = 1; i < L.length; i++) list.push({ n: i, a: Math.max(0, L[i].at - 10 * sr), b: Math.min(ssLen(), L[i].at + 5 * sr) });
  if (!list.length) { flash(t("The montage needs two tracks for a transition.")); return; }
  cdTransStop();
  cd.trans = { list, i: -1, t0: 0, dur: 0 };
  const next = async () => {
    const T = cd.trans;
    if (!T) return;
    T.i++;
    if (T.i >= T.list.length || !ses.open) { cdTransStop(); flash(t("All transitions played")); return; }
    const x = T.list[T.i];
    ses.loop = false;
    ses.sel = { a: x.a, b: x.b };
    T.t0 = performance.now();
    T.on = false;
    T.dur = (x.b - x.a) / sr * 1000;
    flash(t("Transition {a} → {b}").replace("{a}", x.n).replace("{b}", x.n + 1) + " · " + (T.i + 1) + "/" + T.list.length);
    await ssPlay(x.a);
  };
  cd.timer = setInterval(() => {
    const T = cd.trans;
    if (!T || T.i < 0) return;
    if (ses.play.on) { T.on = true; return; }
    if (!T.on) { if (performance.now() - T.t0 > 4000) cdTransStop(); return; }
    if (performance.now() - T.t0 >= T.dur - 400) next(); else cdTransStop();
  }, 120);
  next();
}

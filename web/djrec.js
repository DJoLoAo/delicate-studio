const dj = { job: null, title: "" };
const DJ_RE = /^(.+?)(-atmo)?(?:-part(\d+))?\.wav$/i;

function djKv(key, val) {
  return new Promise((res, rej) => {
    const o = indexedDB.open("studio", 1);
    o.onupgradeneeded = () => o.result.createObjectStore("kv");
    o.onerror = () => rej(o.error);
    o.onsuccess = () => {
      const db = o.result, tx = db.transaction("kv", val === undefined ? "readonly" : "readwrite"), st = tx.objectStore("kv");
      const r = val === undefined ? st.get(key) : st.put(val, key);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      tx.oncomplete = () => db.close();
    };
  });
}

function djTitle(key) {
  const m = /^mix-(\d{4})-(\d{2})-(\d{2})-(\d{2})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return key;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6]));
  try { return d.toLocaleString(i18n.lang, { dateStyle: "medium", timeStyle: "short" }); } catch { return d.toLocaleString(); }
}

function djGroups(items) {
  const by = new Map();
  for (const it of items) {
    const r = DJ_RE.exec(it.name);
    if (!r) continue;
    const g = by.get(r[1]) || { key: r[1], mix: [], atmo: [] };
    (r[2] ? g.atmo : g.mix).push({ n: r[3] ? Number(r[3]) : 1, it });
    by.set(r[1], g);
  }
  const out = [];
  for (const g of by.values()) {
    if (!g.mix.length) continue;
    for (const L of [g.mix, g.atmo]) L.sort((a, b) => a.n - b.n);
    const gap = L => L.findIndex((x, i) => x.n !== i + 1);
    const gm = gap(g.mix), ga = gap(g.atmo);
    g.missing = gm >= 0 ? { kind: "mix", n: gm + 1 } : ga >= 0 ? { kind: "atmo", n: ga + 1 } : null;
    out.push(g);
  }
  return out;
}

async function djFilesOf(L) {
  const out = [];
  for (const x of L) out.push(x.it.getFile ? await x.it.getFile() : x.it);
  return out;
}

async function djScan(dir) {
  const items = [];
  for await (const h of dir.values()) if (h.kind === "file" && /\.wav$/i.test(h.name)) items.push(h);
  return djGroups(items);
}

async function djHistory() {
  try {
    const r = await fetch("/api/history", { credentials: "same-origin" });
    if (!r.ok) return [];
    const j = await r.json();
    return Array.isArray(j) ? j : [];
  } catch { return []; }
}

function djErrText(msg) {
  const [code, name] = String(msg || "").split("|");
  const T = { notwav: "{f} is not a WAV file.", format: "{f} is in a WAV format Studio cannot read here.", nodata: "{f} has no audio, or is shorter than its header says.", mismatch: "{f} does not match the other parts of the recording." };
  return T[code] ? t(T[code]).replace("{f}", name || "") : String(msg || "");
}

async function djDir(fresh) {
  let dir = null;
  if (!fresh) { try { dir = await djKv("djdir"); } catch {} }
  if (dir) {
    try {
      let p = await dir.queryPermission({ mode: "read" });
      if (p !== "granted") p = await dir.requestPermission({ mode: "read" });
      if (p === "granted") return dir;
    } catch {}
  }
  try { dir = await window.showDirectoryPicker({ id: "djrec", mode: "read", startIn: "music" }); }
  catch { return null; }
  try { await djKv("djdir", dir); } catch {}
  return dir;
}

function djPickFiles() {
  return new Promise(res => {
    const i = document.createElement("input");
    i.type = "file";
    i.multiple = true;
    i.accept = ".wav,audio/wav";
    i.addEventListener("change", () => res([...i.files]));
    i.addEventListener("cancel", () => res([]));
    i.click();
  });
}

async function djOpen(fresh) {
  const folder = !!window.showDirectoryPicker;
  let groups = [], dir = null;
  if (folder) {
    dir = await djDir(fresh);
    if (!dir) return;
    try { groups = await djScan(dir); } catch (e) { tell(String(e.message || e), t("Could not read the folder")); return; }
  } else {
    const files = await djPickFiles();
    if (!files.length) return;
    groups = djGroups(files);
  }
  if (!groups.length) {
    const again = await ask(t("No DJ recordings here"), t("Recordings from Delicate DJ are WAV files named like mix-2026-10-22-21-40-05.wav, with -part2 and -atmo files next to them. Choose the folder you record into."), { ok: t("choose another folder") });
    if (again && folder) djOpen(true);
    return;
  }
  const files = new Map();
  for (const g of groups) { try { files.set(g.key, { mix: await djFilesOf(g.mix), atmo: await djFilesOf(g.atmo) }); } catch {} }
  const order = groups.filter(g => files.has(g.key)).sort((a, b) => b.key.localeCompare(a.key) || (files.get(b.key).mix[0].lastModified || 0) - (files.get(a.key).mix[0].lastModified || 0)).slice(0, 60);
  let probe = [];
  try { probe = (await call({ t: "djprobe", groups: order.map(g => Object.assign({ key: g.key }, files.get(g.key))) })).recs; } catch {}
  const info = new Map(probe.map(p => [p.key, p]));
  const hist = await djHistory();
  const rows = order.map((g, i) => {
    const p = info.get(g.key) || {}, n = hist.filter(r => r.rec_name === g.key).length;
    const bits = p.err ? [djErrText(p.err)] : g.missing ? [t(g.missing.kind === "atmo" ? "Part {n} of the atmo is missing." : "Part {n} is missing.").replace("{n}", g.missing.n)] : [fmtDur(p.frames / p.sr), p.atmo ? t("with atmo") : "", n === 1 ? t("1 track") : n ? t("{n} tracks").replace("{n}", n) : ""];
    const bad = !!(p.err || g.missing || !p.sr);
    return `<label class="sesdoc djrec${bad ? " bad" : ""}"><input type="radio" name="rec" value="${esc(g.key)}"${bad ? " disabled" : ""}><span class="sdn">${esc(djTitle(g.key))}</span><span class="sdi">${esc(bits.filter(Boolean).join(" · "))}</span></label>`;
  });
  const first = order.find(g => { const p = info.get(g.key); return p && !p.err && !g.missing && p.sr; });
  const v = await askForm(t("Open a DJ recording"), `<div class="sesdocs">${rows.join("")}</div><div class="dnote">${esc(t("Studio makes a session from it: the mix on one track and the atmo on its own, lined up with the mix, with the tracklist from your play history as markers."))}</div>${folder ? `<button type="button" class="outbtn djother">${esc(t("choose another folder"))}</button>` : ""}`, {
    ok: t("open"),
    setup: f => {
      if (first) { const r = f.querySelector(`input[value="${CSS.escape(first.key)}"]`); if (r) r.checked = true; }
      const b = f.querySelector(".djother");
      if (b) b.addEventListener("click", () => { dlgClose({ other: true }); });
    },
    read: () => { const r = dlg.el.querySelector(".dform input[name=rec]:checked"); return { rec: r ? r.value : "" }; }
  });
  if (!v) return;
  if (v.other) { djOpen(true); return; }
  const g = order.find(x => x.key === v.rec);
  if (!g) return;
  await djImport(g, files.get(g.key), info.get(g.key), hist);
}

function djProg(m) {
  if (!dj.job || m.id !== dj.job) return false;
  $("busy").classList.remove("hidden");
  $("busyTitle").textContent = t("Reading");
  $("busyName").textContent = dj.title;
  $("busyBar").style.width = Math.round((m.frac || 0) * 100) + "%";
  $("busyPct").textContent = Math.round((m.frac || 0) * 100) + "%";
  return true;
}

async function djImport(g, f, p, hist) {
  const sr = p.sr, when = djTitle(g.key), name = t("DJ set {d}").replace("{d}", when);
  const rows = hist.filter(r => r.rec_name === g.key && Number.isFinite(Number(r.rec_offset))).sort((a, b) => a.rec_offset - b.rec_offset);
  const marks = rows.map(r => ({ id: ssNewId(), at: Math.max(0, Math.round(Number(r.rec_offset) * sr)), name: ((r.artist ? r.artist + " - " : "") + (r.title || "")).trim() }));
  const jobId = "dj" + Date.now();
  dj.job = jobId;
  dj.title = name;
  djProg({ id: jobId, frac: 0 });
  let r;
  try {
    r = await call({ t: "djimport", jobId, mix: f.mix, atmo: f.atmo, rec: g.key, marks: marks.map(m => ({ at: m.at, name: m.name })), mixName: g.key + (f.atmo.length ? " (" + t("without atmo") + ")" : "") + ".wav", atmoName: g.key + "-atmo.wav" });
  } catch (e) {
    if ((e && e.message) !== "cancelled") tell(djErrText(e && e.message), t("Could not open the DJ recording"));
    return;
  } finally {
    dj.job = null;
    $("busy").classList.add("hidden");
  }
  const tracks = [{ id: ssNewId(), name: t("Mix"), gain: 0, pan: 0, mute: false, solo: false, clips: [{ id: ssNewId(), doc: r.mix.id, at: 0, from: 0, len: r.mix.frames, gain: 0, fin: 0, fout: 0, name: r.mix.name }] }];
  let ak = null;
  if (r.atmo) {
    const from = Math.max(0, -r.offset);
    ak = { id: ssNewId(), doc: r.atmo.id, at: Math.max(0, r.offset), from, len: r.atmo.frames - from, gain: r.atmo.channels === 1 && r.mix.channels === 2 ? 20 * Math.log10(Math.SQRT2) : 0, fin: 0, fout: 0, name: r.atmo.name };
    tracks.push({ id: ssNewId(), name: t("Atmo"), gain: 0, pan: 0, mute: false, solo: false, clips: [ak] });
  }
  let s;
  try { s = (await call({ t: "sesnew", name, sr: r.sr, tracks, marks, src: { kind: "dj", rec: g.key } })).s; }
  catch (e) { tell(String(e.message || e), t("Could not save the session")); return; }
  refreshFiles();
  await ssOpen(s.id);
  const notes = [];
  if (marks.length) notes.push(marks.length === 1 ? t("1 track from your play history") : t("{n} tracks from your play history").replace("{n}", marks.length));
  const al = r.align;
  if (ak && al && al.found && al.lag > 0) {
    const tr = ses.s.tracks[1], k = tr && tr.clips[0];
    if (k) {
      let at = k.at - al.lag, from = k.from, len = k.len;
      if (at < 0) { from -= at; len += at; at = 0; }
      Object.assign(k, { at, from, len });
      ssCommit();
      notes.push(t("atmo lined up with the mix: {ms} ms earlier, Undo puts it back as recorded").replace("{ms}", Math.round(al.lag / r.sr * 1000)));
    }
  } else if (ak) notes.push(t("the atmo stays where it was recorded"));
  if (r.clipped) notes.push(t("the mix hit full scale in {n} places while the atmo was in it").replace("{n}", r.clipped));
  flash(name + (notes.length ? ": " + notes.join(" · ") : ""));
}

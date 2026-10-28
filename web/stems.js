const STM_Q = [
  { v: "std", label: "4 stems", q: "" },
  { v: "hq", label: "4 stems, high quality", q: "?hq=1" },
  { v: "6s", label: "6 stems, with guitar and piano", q: "?six=1" }
];
const STM_NAMES = { drums: "Drums", bass: "Bass", vocals: "Vocals", other: "Other", guitar: "Guitar", piano: "Piano" };
const STM_PLAN = { gold: "Gold", pro: "Pro", free: "Free" };
const stm = { job: null };

function stmButton(src) {
  const b = document.createElement("button");
  b.className = "outbtn fstem";
  b.textContent = t("stems");
  b.title = t("Split into stems with Stemina and open them in a session");
  b.addEventListener("click", ev => { ev.stopPropagation(); closeFiles(); stmOpen(src); });
  return b;
}

function stmSource(d) {
  const s = d && d.source;
  if (!s || (s.kind !== "library" && s.kind !== "locker") || !s.id) return null;
  return { kind: s.kind, id: String(s.id), title: s.title || (d.name || "").replace(/\.[^.]+$/, ""), artist: s.artist || "", album: s.album || "", path: s.path || "", doc: d.id };
}

async function stmFromDoc() {
  const src = stmSource(ed.doc);
  if (!src) { await tell(t("Stems come from Delicate DJ, so they work for files opened from your Library or your Locker.")); return; }
  await stmOpen(src);
}

async function stmOpen(src) {
  if (stm.job) return;
  let q = "std", keep = true;
  try { const v = JSON.parse(localStorage.getItem("studioStems") || "null") || {}; if (STM_Q.some(x => x.v === v.q)) q = v.q; keep = v.keep !== false; } catch {}
  const name = [src.artist, src.title].filter(Boolean).join(" – ") || src.path || src.id;
  const html = `<div class="dnote">${esc(name)}</div>${segHtml("q", STM_Q.map(x => [x.v, x.label]), q)}<label class="sesdoc"><input type="checkbox" name="keep" ${keep ? "checked" : ""}><span>${esc(t("also the original, muted, on its own track"))}</span></label><div class="dnote">${esc(t("Stemina in Delicate DJ splits the track. Stems made before open at once; new ones take a minute or two."))}</div>`;
  const v = await askForm(t("Stems in a session"), html, { ok: t("make the session"), setup: segSetup, read: () => segRead(document.querySelector("#dlg .dform")) });
  if (!v) return;
  q = STM_Q.some(x => x.v === v.q) ? v.q : "std";
  keep = !!v.keep;
  try { localStorage.setItem("studioStems", JSON.stringify({ q, keep })); } catch {}
  await stmRun(src, q, keep, name);
}

function stmMsg(text) {
  clearTimeout(ed.flashT);
  $("stMsg").textContent = text;
}

async function stmPoll(job) {
  for (;;) {
    await new Promise(r => setTimeout(r, 1000));
    if (!stm.job) throw new Error("cancelled");
    const r = await fetch("/api/job/" + encodeURIComponent(job), { cache: "no-store" });
    if (r.status === 401) throw new Error("login");
    if (!r.ok) throw new Error("stm-job");
    const j = await r.json();
    if (j.error) throw new Error(String(j.error));
    if (j.done) return j.done;
    stmMsg(t("Stems") + " · " + (j.phase ? t(j.phase) + " · " : "") + Math.round((j.progress || 0) * 100) + " %");
  }
}

function stmErr(m) {
  return ({ login: t("Your session has ended. Log in again."), "stm-job": t("Delicate DJ lost track of the stem job. Try again."), "stm-none": t("Delicate DJ could not make stems for this track.") })[m] || m;
}

async function stmImport(id, stem, base) {
  const have = (ed.docs || []).find(d => d.source && d.source.kind === "stem" && d.source.id === id && d.source.stem === stem);
  if (have) return have;
  const r = await call({ t: "import", url: "/api/stream/" + encodeURIComponent(id) + "/" + stem, name: base + " – " + stem, ext: "flac", source: { kind: "stem", id, stem } });
  $("busy").classList.add("hidden");
  return Object.assign({}, r.meta, { frames: r.meta.frames });
}

async function stmRun(src, q, keep, name) {
  stm.job = { id: src.id };
  const quality = STM_Q.find(x => x.v === q);
  try {
    stmMsg(t("Stems") + " · " + t("asking Delicate DJ"));
    const r = await fetch("/api/stems/" + encodeURIComponent(src.id) + quality.q, { method: "POST" });
    if (r.status === 401) throw new Error("login");
    if (r.status === 402) {
      const j = await r.json().catch(() => ({}));
      throw new Error(t("{q} needs the {p} plan in Delicate DJ.").replace("{q}", t(quality.label)).replace("{p}", STM_PLAN[j.upgrade] || j.upgrade || "?"));
    }
    if (!r.ok) throw new Error("stm-none");
    let j = await r.json();
    if (j.job) j = await stmPoll(j.job);
    const names = Array.isArray(j.stems) && j.stems.length ? j.stems : null;
    if (!names) throw new Error("stm-none");
    const base = name.slice(0, 120), docs = [];
    for (let i = 0; i < names.length; i++) {
      stmMsg(t("Stems") + " · " + t("loading {s}").replace("{s}", t(STM_NAMES[names[i]] || names[i])) + " · " + (i + 1) + "/" + names.length);
      docs.push({ stem: names[i], m: await stmImport(src.id, names[i], base) });
    }
    let orig = null;
    if (keep) {
      const have = (ed.docs || []).find(d => d.source && d.source.kind === src.kind && String(d.source.id) === src.id);
      if (have) orig = have;
      else {
        stmMsg(t("Stems") + " · " + t("loading the original"));
        const ext = (src.path.match(/\.([a-z0-9]{2,5})$/i) || [])[1] || "";
        const o = await call({ t: "import", url: "/api/stream/" + encodeURIComponent(src.id), name, ext, source: { kind: src.kind, id: src.id, title: src.title, artist: src.artist, album: src.album, path: src.path } });
        $("busy").classList.add("hidden");
        orig = o.meta;
      }
    }
    const sr = docs[0].m.sampleRate, skipped = [];
    const clip = (m, label) => ({ id: ssNewId(), name: label, gain: 0, pan: 0, mute: false, solo: false, clips: [{ id: ssNewId(), doc: m.id, at: 0, from: 0, len: m.frames, gain: 0, fin: 0, fout: 0, name: m.name }] });
    const tracks = [];
    for (const x of docs) { if (x.m.sampleRate !== sr) { skipped.push(x.stem); continue; } tracks.push(clip(x.m, t(STM_NAMES[x.stem] || x.stem))); }
    if (orig && orig.sampleRate === sr) { const tr = clip(orig, t("Original")); tr.mute = true; tracks.push(tr); }
    const s = (await call({ t: "sesnew", name: base + " · " + t("stems"), sr, tracks, marks: [], src: { kind: "stems", id: src.id, quality: j.quality || q } })).s;
    stmMsg("");
    refreshFiles();
    await ssOpen(s.id);
    flash(t("{n} stems on their own tracks").replace("{n}", tracks.length - (orig ? 1 : 0)) + (skipped.length ? " · " + t("left out at another rate") + ": " + skipped.join(", ") : ""));
  } catch (e) {
    stmMsg("");
    const m = String(e.message || e);
    if (m !== "cancelled") tell(stmErr(m), t("Could not make the stems"));
  } finally { stm.job = null; }
}

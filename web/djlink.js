const djl = { crates: null, loading: null };

async function djCrates(force) {
  if (djl.crates && !force) return djl.crates;
  if (djl.loading) return djl.loading;
  djl.loading = (async () => {
    try {
      const r = await fetch("/api/crates", { cache: "no-store" });
      djl.crates = r.ok ? (await r.json()).filter(c => c.kind !== "smart") : [];
    } catch { djl.crates = []; }
    djl.loading = null;
    return djl.crates;
  })();
  return djl.loading;
}

async function djNewCrate() {
  const name = String((await askText(t("New crate"), "", { placeholder: t("Friday peak time") })) || "").trim();
  if (!name) return null;
  try {
    const r = await fetch("/api/crates", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name.slice(0, 60) }) });
    if (!r.ok) throw new Error(String(r.status));
    const id = (await r.json()).id;
    await djCrates(true);
    return id;
  } catch { await tell(t("The crate could not be made in Delicate DJ.")); return null; }
}

function djCrateLabel(id) {
  const c = (djl.crates || []).find(x => x.id === id);
  return c ? c.name : t("No crate");
}

function djCrateDd() {
  const el = $("xCrate");
  if (!el) return;
  const items = [{ v: "0", label: t("No crate") }].concat((djl.crates || []).map(c => ({ v: String(c.id), label: c.name + " · " + c.count }))).concat([{ v: "new", label: "+ " + t("New crate…") }]);
  fxDd(el, items, async v => {
    if (v === "new") { const id = await djNewCrate(); if (id) xp.cfg.crate = id; }
    else xp.cfg.crate = Number(v) || 0;
    xpSave();
    xpRender();
  });
  if (xp.cfg.crate && djl.crates && !djl.crates.some(c => c.id === xp.cfg.crate)) xp.cfg.crate = 0;
  el.querySelector(".cur").textContent = djCrateLabel(xp.cfg.crate || 0);
}

function djTrackOf(j) {
  const tag = k => { const x = (j.tags || []).find(p => p[0] === k); return x ? x[1] : ""; };
  const path = j.locker.path || j.name, base = path.split("/").pop().replace(/\.[^.]+$/, "");
  return { id: "lk-" + j.locker.file, title: tag("TITLE") || base, artist: tag("ARTIST"), album: tag("ALBUM"), duration: Math.round(j.len * 1000) / 1000, path };
}

async function djAddToCrate(j) {
  if (!j.crate || !j.locker || !j.locker.file) return;
  try {
    const r = await fetch("/api/crates/" + j.crate.id + "/items", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ tracks: [djTrackOf(j)] }) });
    if (!r.ok) throw new Error(String(r.status));
    j.crateDone = true;
    flash(t("Added to the DJ crate {c}").replace("{c}", j.crate.name) + ": " + (j.locker.path || j.name));
    djCrates(true);
  } catch { tell(t("{f} is in the Locker, but it could not be added to the crate {c}.").replace("{f}", j.locker.path || j.name).replace("{c}", j.crate.name)); }
}

function djStamp(sec, long) {
  const s = Math.max(0, Math.floor(sec + 1e-6)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), x = s % 60;
  return long ? h + ":" + String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0") : String(m).padStart(2, "0") + ":" + String(x).padStart(2, "0");
}

function djTracklistText(style) {
  const sr = ed.doc.sampleRate, marks = (ed.marks || []).filter(m => m.kind !== "view").slice().sort((a, b) => a.a - b.a);
  const long = ed.doc.frames / sr >= 3600;
  return marks.map((m, i) => {
    const name = String(m.name || "").trim() || t("Marker") + " " + m.n;
    const at = djStamp(m.a / sr, long);
    return style === "numbered" ? String(i + 1).padStart(2, "0") + ". " + at + " " + name : style === "bracket" ? "[" + at + "] " + name : at + " " + name;
  }).join("\n");
}

async function djTracklist() {
  if (!ed.doc) return;
  const marks = (ed.marks || []).filter(m => m.kind !== "view");
  if (!marks.length) { await tell(t("This file has no markers yet. A DJ recording opened from Sessions → DJ recording… brings the tracklist from your play history; or add markers with M.")); return; }
  let style = "plain";
  try { style = localStorage.getItem("studioTracklist") || "plain"; } catch {}
  const html = `<div class="seg" id="tlStyle"><button type="button" class="segbtn" data-v="plain">00:00 Name</button><button type="button" class="segbtn" data-v="bracket">[00:00] Name</button><button type="button" class="segbtn" data-v="numbered">01. 00:00 Name</button></div><textarea class="tltext" id="tlText" readonly spellcheck="false"></textarea><div class="brow"><button type="button" class="outbtn" id="tlCopy">${esc(t("copy"))}</button><button type="button" class="outbtn" id="tlSave">${esc(t("save as text"))}</button></div><div class="dnote">${esc(t("Times come from the markers, one line each, ready for Mixcloud, YouTube or SoundCloud. Export can write a .cue sheet next to the audio as well."))}</div>`;
  const setup = f => {
    const fill = () => { f.querySelector("#tlText").value = djTracklistText(style); f.querySelectorAll("#tlStyle button").forEach(b => b.classList.toggle("on", b.dataset.v === style)); };
    f.querySelector("#tlStyle").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; style = b.dataset.v; try { localStorage.setItem("studioTracklist", style); } catch {} fill(); });
    f.querySelector("#tlCopy").addEventListener("click", async () => { try { await navigator.clipboard.writeText(djTracklistText(style)); flash(t("Tracklist copied")); } catch { f.querySelector("#tlText").select(); } });
    f.querySelector("#tlSave").addEventListener("click", () => {
      const a = document.createElement("a"), url = URL.createObjectURL(new Blob([djTracklistText(style) + "\n"], { type: "text/plain;charset=utf-8" }));
      a.href = url;
      a.download = (xpClean(ed.doc.name.replace(/\.[^.]+$/, "") + " tracklist") || "tracklist") + ".txt";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 30000);
      flash(t("Saved") + " " + a.download);
    });
    fill();
  };
  await askForm(t("Tracklist"), html, { ok: t("close"), setup });
}

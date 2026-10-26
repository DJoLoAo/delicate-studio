const pb = { cfg: null, xhr: null, st: null };
const PB_DEFAULT = { to: "mixcloud", folder: "Mixes", tags: "" };
const PB_TO = ["mixcloud", "soundcloud", "replay", "locker"];
const PB_NAME = { mixcloud: "Mixcloud", soundcloud: "SoundCloud", replay: "listener page", locker: "Locker" };
const PB_DJ = "https://dj.delicateaudio.com";

function pbLoad() {
  let c = {};
  try { c = JSON.parse(localStorage.getItem("studioPublish") || "{}") || {}; } catch {}
  pb.cfg = Object.assign({}, PB_DEFAULT, c);
  if (!PB_TO.includes(pb.cfg.to)) pb.cfg.to = "mixcloud";
}

function pbSave() { try { localStorage.setItem("studioPublish", JSON.stringify(pb.cfg)); } catch {} }

function pbHms(s) {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor(s / 60) % 60, x = s % 60, p = n => String(n).padStart(2, "0");
  return h ? h + ":" + p(m) + ":" + p(x) : m + ":" + p(x);
}

function pbTracklist() {
  if (!ed.doc) return "";
  const sr = ed.doc.sampleRate;
  return (ed.marks || []).filter(m => (m.kind === "point" || m.kind === "range") && String(m.name || "").trim()).sort((a, b) => a.a - b.a).map(m => pbHms(m.a / sr) + " " + String(m.name).trim()).join("\n");
}

function pbSections(text) {
  const out = [];
  for (const raw of String(text || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s+(.*)$/.exec(line);
    const start = m ? (Number(m[1] || 0) * 3600 + Number(m[2]) * 60 + Number(m[3])) : null;
    const rest = (m ? m[4] : line).trim();
    const d = rest.indexOf(" - ");
    if (d > 0) out.push({ start, artist: rest.slice(0, d).trim(), song: rest.slice(d + 3).trim() });
    else out.push({ start, chapter: rest });
  }
  return out.slice(0, 200);
}

async function pbStatus() {
  try {
    const r = await fetch("/api/cloud", { credentials: "same-origin" });
    const j = r.ok ? await r.json() : null;
    pb.st = j && Array.isArray(j.providers) ? j.providers : [];
  } catch { pb.st = []; }
  return pb.st.find(p => p.id === "mixcloud") || null;
}

function pbProv(id) { return (pb.st || []).find(p => p.id === id) || null; }

function pbLine(to) {
  if (to === "replay") return t("The listener page plays it as a replay with the tracklist, under your live stream. Listeners need no account.");
  if (to === "locker") return "";
  const p = pbProv(to), n = PB_NAME[to];
  if (!p || !p.configured) return t("{n} is not set up on this server yet.").replace("{n}", n);
  if (!p.connected) return t("{n} is not connected. Connect it in Delicate DJ under Settings → Sources.").replace("{n}", n);
  return t("Connected as {a}.").replace("{a}", p.account || "—");
}

async function pbToken() {
  const r = await fetch("/api/cloud/mixcloud/token", { credentials: "same-origin" });
  if (r.status === 404) throw new Error(t("Mixcloud is not connected. Connect it in Delicate DJ under Settings → Sources."));
  if (!r.ok) throw new Error((await r.text()) || t("No access to Mixcloud."));
  return (await r.json()).access_token;
}

function pbName(s) { return String(s || "").replace(/[\\/:*?"<>|]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 120) || "mix"; }

function pbDefTitle() {
  const n = ed.doc ? String(ed.doc.name || "").replace(/\.[a-z0-9]{2,4}$/i, "") : "";
  return n.replace(/\s*\((mix|without atmo)\)$/i, "").trim();
}

async function pbOpen() {
  if (ses.open) {
    if (!(ssLen() > 0)) return;
    await ssBounce(false);
  }
  if (!ed.doc) return;
  if (!pb.cfg) pbLoad();
  const mc = await pbStatus();
  const c = pb.cfg, frames = ed.doc.frames, sr = ed.doc.sampleRate;
  let cover = null, unlisted = false;
  const html = `<div class="seg pbto" id="pbTo">${PB_TO.map(k => `<button type="button" class="segbtn" data-v="${k}">${esc(k === "replay" ? t("Listener page") : t(PB_NAME[k]))}</button>`).join("")}</div>
<div class="pbinfo dnote" id="pbMc"><span id="pbLine"></span> <a id="pbDj" href="${PB_DJ}/" target="_blank" rel="noopener">${esc(t("open Delicate DJ"))}</a></div>
<label class="dfield"><span>${esc(t("Title"))}</span><input name="title" maxlength="100" value="${esc(pbDefTitle())}" spellcheck="false" autocomplete="off"></label>
<label class="dfield pbmc"><span>${esc(t("Description (optional)"))}</span><textarea name="desc" maxlength="1000" rows="2"></textarea></label>
<label class="dfield pbmc pbsc"><span>${esc(t("Tags, up to five, separated by commas"))}</span><input name="tags" maxlength="200" value="${esc(c.tags)}" placeholder="deep house, vinyl, live" spellcheck="false" autocomplete="off"></label>
<label class="dfield pbmc"><span>${esc(t("Tracklist, one track per line: time artist - title"))}</span><textarea name="tracks" rows="6" spellcheck="false">${esc(pbTracklist())}</textarea></label>
<div class="dfield pbmc pbcov"><span>${esc(t("Cover (optional, up to 10 MB)"))}</span><div class="pbrow"><button type="button" class="outbtn" id="pbCover">${esc(t("choose image…"))}</button><span class="pbcn" id="pbCoverName">—</span></div></div>
<div class="pbrow pbmc"><button type="button" class="outbtn" id="pbUnl"></button></div>
<label class="dfield pblk"><span>${esc(t("Folder in the Locker"))}</span><input name="folder" value="${esc(c.folder)}" spellcheck="false" autocomplete="off"></label>
<div class="dnote">${esc(t("Studio renders the whole file as FLAC, 24 bit at {r} kHz, {d}.").replace("{r}", (sr / 1000).toLocaleString()).replace("{d}", fmtDur(frames / sr)))} <span id="pbHow"></span></div>`;
  const v = await askForm(t("Publish"), html, {
    ok: t("publish"),
    setup: f => {
      const show = () => {
        const to = c.to, p = pbProv(to);
        f.querySelectorAll("#pbTo .segbtn").forEach(b => b.classList.toggle("on", b.dataset.v === to));
        f.querySelectorAll(".pbmc").forEach(e => e.classList.toggle("hidden", to === "locker"));
        f.querySelectorAll(".pbsc").forEach(e => e.classList.toggle("hidden", to === "replay" || to === "locker"));
        f.querySelectorAll(".pbcov").forEach(e => e.classList.toggle("hidden", to !== "mixcloud"));
        f.querySelectorAll(".pblk").forEach(e => e.classList.toggle("hidden", to === "mixcloud"));
        f.querySelector("#pbMc").classList.toggle("hidden", to === "locker");
        f.querySelector("#pbLine").textContent = pbLine(to);
        f.querySelector("#pbDj").classList.toggle("hidden", !(p && p.configured && !p.connected));
        f.querySelector("#pbUnl").textContent = to === "soundcloud" ? t("private: only you on SoundCloud") : t("unlisted: only people with the link");
        f.querySelector("#pbHow").textContent = to === "mixcloud" ? t("It goes straight from this browser to your Mixcloud account, with the tracklist as sections.") : to === "soundcloud" ? t("It goes into this Locker folder, and Delicate DJ sends it from there to SoundCloud, with the tracklist in the description.") : to === "replay" ? t("It goes into this Locker folder, and your listener page plays it from there.") : "";
      };
      f.querySelector("#pbTo").addEventListener("click", e => { const b = e.target.closest(".segbtn"); if (!b) return; c.to = b.dataset.v; show(); });
      f.querySelector("#pbCover").addEventListener("click", () => {
        const i = document.createElement("input");
        i.type = "file";
        i.accept = "image/*";
        i.addEventListener("change", () => { cover = i.files[0] || null; f.querySelector("#pbCoverName").textContent = cover ? cover.name : "—"; });
        i.click();
      });
      f.querySelector("#pbUnl").addEventListener("click", e => { unlisted = !unlisted; e.currentTarget.classList.toggle("on", unlisted); });
      show();
      requestAnimationFrame(() => { const i = f.querySelector("input[name=title]"); if (i) i.select(); });
    },
    read: () => { const f = dlg.el.querySelector(".dform"), g = n => f.querySelector(`[name=${n}]`).value; return { title: g("title").trim(), desc: g("desc").trim(), tags: g("tags"), tracks: g("tracks"), folder: g("folder").trim() }; }
  });
  if (!v) return;
  c.folder = v.folder || c.folder;
  c.tags = v.tags;
  pbSave();
  if (!v.title) { tell(t("Give the mix a title.")); return; }
  if (c.to === "mixcloud" || c.to === "soundcloud") {
    const p = pbProv(c.to);
    if (!p || !p.configured || !p.connected) { tell(pbLine(c.to)); return; }
    if (c.to === "mixcloud" && cover && cover.size > 10e6) { tell(t("The cover is larger than 10 MB.")); return; }
  }
  pbRender(c.to, v, cover, unlisted);
}

function pbRender(to, v, cover, unlisted) {
  const d = ed.doc, fmt = { type: "flac", bits: 24, rate: 0 }, name = pbName(v.title) + ".flac";
  const dest = to === "mixcloud" ? { kind: "publish" } : { kind: "locker", folder: pb.cfg.folder };
  const tags = xpDocTags(null).filter(x => x[0] !== "TITLE").concat([["TITLE", v.title]]);
  const marks = xpMarks({ a: 0, b: d.frames });
  const id = "x" + Date.now().toString(36) + (++xp.seq);
  const job = { id, name, fmt, dest, state: "queued", frac: 0, doc: d.name, fmtLabel: xpFmtLabel(fmt, d.sampleRate), len: d.frames / d.sampleRate, pos: "", pub: { to, v, cover, unlisted } };
  xp.jobs.push(job);
  call({ t: "export", id: d.id, jobId: id, a: 0, b: d.frames, name, fmt, master: { gain: 0, dither: "tpdf", shaping: "off" }, dest, tags, pic: null, marks: marks.map(m => ({ a: m.a, b: m.b, name: m.name, isrc: m.isrc })) }).catch(e => { job.state = "failed"; job.error = e.message; xpQueue(); });
  xpQueue();
  xpBadge();
  flash((to === "replay" ? t("Rendering for your listener page") : t("Rendering for {d}").replace("{d}", to === "locker" ? t("the Locker") : PB_NAME[to])) + " · " + v.title);
}

function pbDone(j) {
  if (!j.pub) return;
  if (j.pub.to === "locker") { flash(t("Published to the Locker") + ": " + (j.locker ? j.locker.path : j.name)); return; }
  if (j.pub.to === "mixcloud") { pbMixcloud(j); return; }
  pbServer(j);
}

async function pbServer(j) {
  const { to, v, unlisted } = j.pub;
  if (!j.locker || !j.locker.file) { j.state = "failed"; j.error = t("The Locker did not return the file."); xpQueue(); xpBadge(); return; }
  const body = { file: j.locker.file, target: to, title: v.title, description: v.desc, tags: v.tags.split(",").map(s => s.trim()).filter(Boolean).slice(0, 10), tracks: pbSections(v.tracks), unlisted };
  j.state = "publishing";
  j.frac = 0;
  xpQueue();
  xpBadge();
  let id;
  try {
    const r = await fetch("/api/publish", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (!r.ok) throw new Error((await r.text()) || r.status + "");
    id = (await r.json()).id;
  } catch (e) { j.state = "failed"; j.error = e.message; xpQueue(); xpBadge(); tell(e.message, t("Could not publish")); return; }
  for (;;) {
    await new Promise(res => setTimeout(res, 1500));
    let s = null;
    try { const r = await fetch("/api/publish/" + id, { credentials: "same-origin" }); s = r.ok ? await r.json() : null; } catch {}
    if (!s) continue;
    if (s.status === "done") {
      j.state = "done";
      j.frac = 1;
      j.url = /^https?:/.test(s.url) ? s.url : s.url ? PB_DJ + s.url : "";
      xpQueue();
      xpBadge();
      flash((to === "replay" ? t("Published to your listener page") : t("Published to {d}").replace("{d}", PB_NAME[to])) + ": " + v.title, 12000);
      return;
    }
    if (s.status === "failed") { j.state = "failed"; j.error = s.error; xpQueue(); xpBadge(); tell(s.error, t("Could not publish")); return; }
    j.frac = s.total ? s.sent / s.total : 0;
    xpQueue();
  }
}

async function pbMixcloud(j) {
  const { v, cover, unlisted } = j.pub;
  let file, tok;
  try { file = await xpFile(j); } catch { tell(t("The rendered file is no longer here. Render it again."), t("Could not publish")); return; }
  if (file.size > 4e9) { tell(t("Mixcloud accepts files up to 4 GB."), t("Could not publish")); return; }
  try { tok = await pbToken(); } catch (e) { tell(e.message, t("Could not publish")); return; }
  const fd = new FormData();
  fd.append("mp3", file, j.name);
  fd.append("name", v.title.slice(0, 100));
  if (v.desc) fd.append("description", v.desc.slice(0, 1000));
  v.tags.split(",").map(s => s.trim()).filter(Boolean).slice(0, 5).forEach((tg, i) => fd.append("tags-" + i + "-tag", tg));
  pbSections(v.tracks).forEach((s, i) => {
    if (s.chapter) fd.append("sections-" + i + "-chapter", s.chapter);
    else { fd.append("sections-" + i + "-artist", s.artist); fd.append("sections-" + i + "-song", s.song); }
    if (s.start !== null) fd.append("sections-" + i + "-start_time", String(s.start));
  });
  if (cover) fd.append("picture", cover, cover.name);
  if (unlisted) fd.append("unlisted", "1");
  j.state = "uploading";
  j.frac = 0;
  xpQueue();
  xpBadge();
  const xhr = pb.xhr = new XMLHttpRequest();
  xhr.open("POST", "https://api.mixcloud.com/upload/?access_token=" + encodeURIComponent(tok));
  xhr.upload.onprogress = e => { if (e.lengthComputable) { j.frac = e.loaded / e.total; xpQueue(); } };
  const end = (state, msg) => { pb.xhr = null; j.state = state; j.frac = 1; if (msg) j.error = msg; xpQueue(); xpBadge(); };
  xhr.onerror = () => { end("failed", t("No answer from Mixcloud.")); tell(t("The upload stopped: no answer from Mixcloud. Check the connection and publish again."), t("Could not publish")); };
  xhr.onabort = () => end("cancelled");
  xhr.onload = () => {
    let r = null;
    try { r = JSON.parse(xhr.responseText); } catch {}
    if (xhr.status >= 200 && xhr.status < 300 && r && r.result && r.result.success) {
      j.url = "https://www.mixcloud.com" + (r.result.key || "/");
      end("done");
      flash(t("Published on Mixcloud") + ": " + v.title, 12000);
      return;
    }
    const err = r && r.error ? (r.error.message || r.error.type) + (r.details ? " — " + Object.entries(r.details).map(([k, x]) => k + ": " + [].concat(x).join(" ")).join("; ") : "") : xhr.status + " " + xhr.statusText;
    end("failed", err);
    tell(t("Mixcloud did not accept the upload") + ": " + err, t("Could not publish"));
  };
  xhr.send(fd);
}

function pbCancel(j) {
  if (j && j.pub && j.state === "uploading" && pb.xhr) { pb.xhr.abort(); return true; }
  return false;
}

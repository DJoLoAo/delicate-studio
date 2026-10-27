const PR_PPQ = 480;
const PR_SNAPS = [{ v: "4", label: "1/4", d: 4 }, { v: "8", label: "1/8", d: 8 }, { v: "16", label: "1/16", d: 16 }, { v: "32", label: "1/32", d: 32 }, { v: "8t", label: "1/8 triplet", d: 12 }, { v: "16t", label: "1/16 triplet", d: 24 }, { v: "off", label: "No snap", d: 0 }];
const PR_VOICES = [{ v: "keys", label: "Soft keys" }, { v: "lead", label: "Saw lead" }, { v: "sine", label: "Sine" }];
const PR_COLORS = ["gblue", "pink", "ggreen", "ggold", "ice", "warm", "gred", "grey"];
const PR_KEYW = 46, PR_RULER = 22, PR_VEL = 64;
const pr = { open: false, s: null, track: 0, sel: new Set(), tool: "select", snap: "16", voice: "keys", out: "", hist: [], fut: [], view: { x: 0, ppx: 0.12, top: 84, kh: 12 }, play: null, head: 0, loop: null, loopOn: false, drag: null, clip: null, saveT: 0, midi: null, audio: null, audioOn: true, audioLvl: 0.8, list: [] };

function prId() { return "m" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

function prNew(name) {
  return { v: 1, id: prId(), name: name || t("New MIDI"), ppq: PR_PPQ, tempos: [{ tick: 0, us: 500000 }], ts: [4, 4], tracks: [{ name: t("Track") + " 1", ch: 0, program: 0, mute: false, notes: [], extra: [] }], source: null, created: Date.now(), updated: Date.now(), nid: 1 };
}

function prVlqRead(b, p) {
  let v = 0, c;
  do { c = b[p.i++]; v = (v << 7) | (c & 127); } while (c & 128 && p.i < b.length);
  return v;
}

function prParse(bytes, name) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const str = (o, n) => String.fromCharCode(...b.subarray(o, o + n));
  const u32 = o => ((b[o] << 24) >>> 0) + (b[o + 1] << 16) + (b[o + 2] << 8) + b[o + 3];
  if (str(0, 4) !== "MThd") throw new Error("pr-bad");
  const hl = u32(4), fmt = (b[8] << 8) | b[9], div = (b[12] << 8) | b[13];
  if (div & 0x8000) throw new Error("pr-smpte");
  const ppq = div || PR_PPQ;
  let p = 8 + hl;
  const tempos = [], raw = [];
  let ts = null, title = "";
  while (p + 8 <= b.length) {
    const id = str(p, 4), len = u32(p + 4), end = Math.min(b.length, p + 8 + len);
    if (id !== "MTrk") { p = end; continue; }
    const pos = { i: p + 8 }, tr = { name: "", notes: [], extra: [], programs: {} }, open = new Map();
    let tick = 0, run = 0;
    while (pos.i < end) {
      tick += prVlqRead(b, pos);
      let st = b[pos.i];
      if (st < 0x80) st = run; else pos.i++;
      if (st === 0xff) {
        const type = b[pos.i++], l = prVlqRead(b, pos), d = b.subarray(pos.i, pos.i + l);
        pos.i += l;
        if (type === 0x03) tr.name = new TextDecoder().decode(d);
        if (type === 0x51 && l === 3) tempos.push({ tick, us: (d[0] << 16) | (d[1] << 8) | d[2] });
        if (type === 0x58 && l >= 2 && !ts) ts = [d[0], 1 << d[1]];
        if (type === 0x2f) break;
        continue;
      }
      if (st === 0xf0 || st === 0xf7) { const l = prVlqRead(b, pos); pos.i += l; continue; }
      run = st;
      const hi = st & 0xf0, ch = st & 15, n1 = hi === 0xc0 || hi === 0xd0 ? 1 : 2, d = [b[pos.i], b[pos.i + 1]];
      pos.i += n1;
      if (hi === 0x90 && d[1] > 0) {
        const k = ch * 128 + d[0];
        if (!open.has(k)) open.set(k, []);
        open.get(k).push({ tick, v: d[1] });
      } else if (hi === 0x80 || hi === 0x90) {
        const q = open.get(ch * 128 + d[0]);
        const on = q && q.shift();
        if (on) tr.notes.push({ p: d[0], t: on.tick, d: Math.max(1, tick - on.tick), v: on.v, ch });
      } else if (hi === 0xc0) {
        if (!(ch in tr.programs)) tr.programs[ch] = d[0];
      } else tr.extra.push({ tick, b: n1 === 1 ? [st, d[0]] : [st, d[0], d[1]] });
    }
    for (const [k, q] of open) for (const on of q) tr.notes.push({ p: k & 127, t: on.tick, d: Math.max(1, tick - on.tick), v: on.v, ch: k >> 7 });
    if (!title && tr.name && !tr.notes.length) title = tr.name;
    raw.push(tr);
    p = end;
  }
  const s = prNew(title || String(name || "MIDI").replace(/\.midi?$/i, ""));
  s.ppq = ppq;
  s.tempos = tempos.length ? tempos.sort((x, y) => x.tick - y.tick).filter((x, i, a) => i === 0 || x.tick !== a[i - 1].tick) : [{ tick: 0, us: 500000 }];
  if (s.tempos[0].tick > 0) s.tempos.unshift({ tick: 0, us: s.tempos[0].us });
  if (ts) s.ts = ts;
  s.tracks = [];
  for (const tr of raw) {
    const chans = [...new Set(tr.notes.map(n => n.ch))];
    if (!tr.notes.length && !tr.extra.length) continue;
    const split = (fmt === 0 || chans.length > 1) && chans.length > 1 ? chans : [chans[0] === undefined ? 0 : chans[0]];
    for (const ch of split) {
      const notes = split.length > 1 ? tr.notes.filter(n => n.ch === ch) : tr.notes;
      const extra = split.length > 1 ? tr.extra.filter(e => (e.b[0] & 15) === ch) : tr.extra;
      s.tracks.push({ name: (tr.name || t("Track") + " " + (s.tracks.length + 1)) + (split.length > 1 ? " · " + t("channel") + " " + (ch + 1) : ""), ch, program: tr.programs[ch] || 0, mute: false, notes: notes.map(n => ({ id: s.nid++, p: n.p, t: n.t, d: n.d, v: n.v, ch: n.ch })), extra });
    }
  }
  if (!s.tracks.length) s.tracks = prNew().tracks;
  for (const tr of s.tracks) tr.notes.sort((x, y) => x.t - y.t || x.p - y.p);
  return s;
}

function prVlq(n, out) {
  const b = [n & 127];
  while ((n = Math.floor(n / 128)) > 0) b.unshift((n & 127) | 128);
  out.push(...b);
}

function prWrite(s) {
  const chunk = evs => {
    evs.sort((x, y) => x.tick - y.tick || x.o - y.o);
    const out = [];
    let prev = 0;
    for (const e of evs) { prVlq(Math.max(0, e.tick - prev), out); out.push(...e.b); prev = Math.max(prev, e.tick); }
    out.push(0, 0xff, 0x2f, 0);
    return [0x4d, 0x54, 0x72, 0x6b, (out.length >>> 24) & 255, (out.length >> 16) & 255, (out.length >> 8) & 255, out.length & 255, ...out];
  };
  const text = (type, str) => { const d = Array.from(new TextEncoder().encode(str)).slice(0, 200), l = []; prVlq(d.length, l); return [0xff, type, ...l, ...d]; };
  const cond = [{ tick: 0, o: 0, b: text(0x03, s.name) }, { tick: 0, o: 0, b: [0xff, 0x58, 4, s.ts[0], Math.round(Math.log2(s.ts[1])), 24, 8] }];
  for (const tp of s.tempos) cond.push({ tick: tp.tick, o: 1, b: [0xff, 0x51, 3, (tp.us >> 16) & 255, (tp.us >> 8) & 255, tp.us & 255] });
  const tracks = [chunk(cond)];
  for (const tr of s.tracks) {
    const ev = [{ tick: 0, o: 0, b: text(0x03, tr.name) }, { tick: 0, o: 1, b: [0xc0 | tr.ch, tr.program & 127] }];
    for (const e of tr.extra || []) ev.push({ tick: e.tick, o: 2, b: e.b });
    for (const n of tr.notes) {
      const ch = n.ch === undefined ? tr.ch : n.ch;
      ev.push({ tick: n.t, o: 4, b: [0x90 | ch, n.p, Math.max(1, Math.min(127, n.v))] });
      ev.push({ tick: n.t + n.d, o: 3, b: [0x80 | ch, n.p, 0] });
    }
    tracks.push(chunk(ev));
  }
  const n = tracks.length, head = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 1, n >> 8, n & 255, s.ppq >> 8, s.ppq & 255];
  const total = head.length + tracks.reduce((v, x) => v + x.length, 0), out = new Uint8Array(total);
  out.set(head, 0);
  let o = head.length;
  for (const x of tracks) { out.set(x, o); o += x.length; }
  return out;
}

function prSegs(s) {
  const out = [];
  let sec = 0;
  s.tempos.forEach((tp, i) => {
    if (i) { const a = s.tempos[i - 1]; sec += (tp.tick - a.tick) * a.us / 1e6 / s.ppq; }
    out.push({ tick: tp.tick, sec, us: tp.us });
  });
  return out;
}

function prSec(tick) {
  const g = pr.segs;
  let k = 0;
  while (k + 1 < g.length && g[k + 1].tick <= tick) k++;
  return g[k].sec + (tick - g[k].tick) * g[k].us / 1e6 / pr.s.ppq;
}

function prTick(sec) {
  const g = pr.segs;
  let k = 0;
  while (k + 1 < g.length && g[k + 1].sec <= sec) k++;
  return g[k].tick + (sec - g[k].sec) * 1e6 * pr.s.ppq / g[k].us;
}

function prBpm() { return Math.round(60e6 / pr.s.tempos[0].us * 100) / 100; }

function prBar() { return pr.s.ppq * 4 * pr.s.ts[0] / pr.s.ts[1]; }

function prGrid() {
  const sn = PR_SNAPS.find(x => x.v === pr.snap) || PR_SNAPS[2];
  return sn.d ? pr.s.ppq * 4 / sn.d : 0;
}

function prSnapT(tick) {
  const g = prGrid();
  return g ? Math.round(tick / g) * g : Math.round(tick);
}

function prLen() {
  let e = 0;
  for (const tr of pr.s.tracks) for (const n of tr.notes) e = Math.max(e, n.t + n.d);
  return Math.max(e, prBar() * 4);
}

function prTr() { return pr.s.tracks[pr.track] || pr.s.tracks[0]; }

async function prDir() {
  const root = await navigator.storage.getDirectory();
  const st = await root.getDirectoryHandle("studio", { create: true });
  return st.getDirectoryHandle("midi", { create: true });
}

async function prStore(s) {
  const d = await prDir(), fh = await d.getFileHandle(s.id + ".json", { create: true }), w = await fh.createWritable();
  await w.write(JSON.stringify(s));
  await w.close();
}

async function prList() {
  const d = await prDir(), out = [];
  for await (const [name, h] of d.entries()) {
    if (!name.endsWith(".json") || h.kind !== "file") continue;
    try {
      const s = JSON.parse(await (await h.getFile()).text());
      out.push({ id: s.id, name: s.name, notes: s.tracks.reduce((v, tr) => v + tr.notes.length, 0), tracks: s.tracks.length, updated: s.updated || 0 });
    } catch {}
  }
  return out.sort((a, b) => b.updated - a.updated);
}

async function prReadSong(id) {
  const d = await prDir();
  return JSON.parse(await (await (await d.getFileHandle(id + ".json")).getFile()).text());
}

async function prDelete(id) {
  const d = await prDir();
  try { await d.removeEntry(id + ".json"); } catch {}
}

function prDirty() {
  pr.s.updated = Date.now();
  clearTimeout(pr.saveT);
  const s = pr.s;
  pr.saveT = setTimeout(() => prStore(s).catch(() => {}), 600);
  prResched();
}

function prPush() {
  pr.hist.push(JSON.stringify({ tracks: pr.s.tracks, tempos: pr.s.tempos, ts: pr.s.ts }));
  if (pr.hist.length > 200) pr.hist.shift();
  pr.fut = [];
}

function prRestore(j) {
  const o = JSON.parse(j);
  pr.s.tracks = o.tracks;
  pr.s.tempos = o.tempos;
  pr.s.ts = o.ts;
  pr.segs = prSegs(pr.s);
  pr.track = Math.min(pr.track, pr.s.tracks.length - 1);
  pr.sel = new Set([...pr.sel].filter(id => prTr().notes.some(n => n.id === id)));
}

function prUndo() {
  if (!pr.hist.length) return;
  pr.fut.push(JSON.stringify({ tracks: pr.s.tracks, tempos: pr.s.tempos, ts: pr.s.ts }));
  prRestore(pr.hist.pop());
  prDirty();
  prRender();
}

function prRedo() {
  if (!pr.fut.length) return;
  pr.hist.push(JSON.stringify({ tracks: pr.s.tracks, tempos: pr.s.tempos, ts: pr.s.ts }));
  prRestore(pr.fut.pop());
  prDirty();
  prRender();
}

async function prOpenSong(s) {
  if (pr.open) await prClose();
  if (ed.play && ed.play.on) stopPlay();
  pr.s = s;
  pr.segs = prSegs(s);
  pr.track = 0;
  pr.sel = new Set();
  pr.hist = [];
  pr.fut = [];
  pr.head = 0;
  pr.loop = null;
  pr.audio = null;
  const ns = s.tracks.flatMap(tr => tr.notes);
  const lo = ns.length ? Math.min(...ns.map(n => n.p)) : 60, hi = ns.length ? Math.max(...ns.map(n => n.p)) : 72;
  pr.open = true;
  $("pr").classList.remove("hidden");
  document.body.classList.add("propen");
  prToolbar();
  const H = Math.max(200, $("prCv").clientHeight - PR_RULER - PR_VEL);
  pr.view.kh = Math.max(7, Math.min(16, Math.floor(H / Math.max(24, hi - lo + 8))));
  pr.view.top = Math.min(127, Math.round((lo + hi) / 2 + H / pr.view.kh / 2));
  const W = Math.max(300, $("prCv").clientWidth - PR_KEYW);
  pr.view.ppx = W / (prLen() * 1.05);
  pr.view.x = 0;
  await prStore(s).catch(() => {});
  prLoadAudio();
  prRender();
}

async function prLoadAudio() {
  const s = pr.s, src = s.source;
  pr.audio = null;
  if (!src || !ed.doc || ed.doc.id !== src.doc) { prRender(); return; }
  try {
    const sr = ed.doc.sampleRate, ch = ed.doc.channels, a = src.a, b = Math.min(ed.doc.frames, src.b || ed.doc.frames);
    const n = b - a, planes = Array.from({ length: ch }, () => new Float32Array(n)), STEP = 1 << 20;
    for (let p = a; p < b; p += STEP) {
      const k = Math.min(STEP, b - p), r = await call({ t: "read", id: ed.doc.id, start: p, count: k });
      for (let c = 0; c < ch; c++) planes[c].set(r.data.subarray(c * r.count, (c + 1) * r.count), p - a);
    }
    if (pr.s !== s) return;
    const env = new Float32Array(Math.ceil(n / 256));
    for (let i = 0; i < env.length; i++) { let m = 0; for (let c = 0; c < ch; c++) for (let j = i * 256; j < Math.min(n, i * 256 + 256); j++) { const v = Math.abs(planes[c][j]); if (v > m) m = v; } env[i] = m; }
    pr.audio = { sr, planes, n, env, name: ed.doc.name };
  } catch { pr.audio = null; }
  prRender();
}

async function prClose() {
  prStop();
  clearTimeout(pr.saveT);
  if (pr.s) await prStore(pr.s).catch(() => {});
  pr.open = false;
  $("pr").classList.add("hidden");
  document.body.classList.remove("propen");
}

async function prNewSong() {
  const name = String((await askText(t("New MIDI"), t("New MIDI"))) || "").trim();
  if (!name) return;
  closeFiles();
  await prOpenSong(prNew(name.slice(0, 120)));
}

async function prImportFile(f) {
  try {
    const s = prParse(new Uint8Array(await f.arrayBuffer()), f.name);
    closeFiles();
    await prOpenSong(s);
    flash(t("Opened in the piano roll") + ": " + s.name);
  } catch (e) { tell(prErr(String(e.message || e)), t("Could not open the MIDI file")); }
}

async function prImportRemote(f) {
  try {
    const r = await fetch("/api/stream/" + encodeURIComponent(f.id), { cache: "no-store" });
    if (!r.ok) throw new Error(r.status === 401 ? "login" : "pr-get");
    const s = prParse(new Uint8Array(await r.arrayBuffer()), (f.path || f.title || "MIDI").split("/").pop());
    closeFiles();
    await prOpenSong(s);
  } catch (e) { tell(prErr(String(e.message || e)), t("Could not open the MIDI file")); }
}

function prErr(m) {
  return ({ "pr-bad": t("This is not a standard MIDI file."), "pr-smpte": t("MIDI files timed in SMPTE frames are not supported."), "pr-get": t("The file could not be downloaded."), login: t("Your session has ended. Log in again.") })[m] || m;
}

function prFromMelody() {
  const r = mdLive(), notes = mdNotes();
  if (!r || !notes.length) return;
  const s = prNew(mdFileName().replace(/\.mid$/, ""));
  const bpm = md.cfg.bpm, tps = PR_PPQ * bpm / 60;
  s.tempos = [{ tick: 0, us: Math.round(60e6 / bpm) }];
  s.tracks[0].name = t("Melody");
  s.tracks[0].notes = notes.map(n => ({ id: s.nid++, p: n.p, t: Math.round(n.s * tps), d: Math.max(1, Math.round((n.e - n.s) * tps)), v: n.v, ch: 0 }));
  s.source = { doc: ed.doc.id, a: r.a, b: r.b, sr: r.sr, name: ed.doc.name };
  closeDiag();
  prOpenSong(s);
}

function prFilesTab() {
  const box = $("prList");
  box.innerHTML = "";
  prList().then(list => {
    box.innerHTML = "";
    if (!list.length) { listNote(box, t("No MIDI yet. Import a .mid file, start a new one, or convert a melody in Repair → MIDI and edit it here.")); return; }
    for (const s of list) {
      const info = [s.tracks === 1 ? t("1 track") : t("{n} tracks").replace("{n}", s.tracks), t("{n} notes").replace("{n}", s.notes), new Date(s.updated).toLocaleDateString()].join(" · ");
      const row = rowEl(s.name, info, async () => { closeFiles(); try { await prOpenSong(await prReadSong(s.id)); } catch { tell(t("This MIDI could not be read.")); } });
      if (pr.open && pr.s && pr.s.id === s.id) row.classList.add("cur");
      const del = document.createElement("button");
      del.className = "x fdel";
      del.textContent = "×";
      del.title = t("Delete the MIDI");
      del.setAttribute("aria-label", t("Delete the MIDI"));
      del.addEventListener("click", async ev => {
        ev.stopPropagation();
        if (!(await ask(t("Delete this MIDI?"), s.name, { ok: t("delete") }))) return;
        if (pr.open && pr.s && pr.s.id === s.id) await prClose();
        await prDelete(s.id);
        prFilesTab();
      });
      row.appendChild(del);
      box.appendChild(row);
    }
  });
}

function prGeom() {
  const cv = $("prCv"), W = cv.clientWidth, H = cv.clientHeight;
  return { W, H, gx: PR_KEYW, gy: PR_RULER, gw: W - PR_KEYW, gh: H - PR_RULER - PR_VEL, vy: H - PR_VEL };
}

function prX(tick) { return PR_KEYW + (tick - pr.view.x) * pr.view.ppx; }
function prXT(x) { return pr.view.x + (x - PR_KEYW) / pr.view.ppx; }
function prY(p) { return PR_RULER + (pr.view.top - p) * pr.view.kh; }
function prYP(y) { return Math.floor(pr.view.top - (y - PR_RULER) / pr.view.kh) + 1; }

function prRender() {
  if (!pr.open) return;
  prToolbar();
  prDraw();
}

function prToolbar() {
  const s = pr.s;
  $("prName").textContent = s.name;
  fxDd($("prTrack"), s.tracks.map((tr, i) => ({ v: String(i), label: (i + 1) + " · " + tr.name + (tr.mute ? " · " + t("muted") : "") })).concat([{ v: "new", label: "+ " + t("New track") }]), v => {
    if (v === "new") { prPush(); s.tracks.push({ name: t("Track") + " " + (s.tracks.length + 1), ch: Math.min(15, s.tracks.length), program: 0, mute: false, notes: [], extra: [] }); pr.track = s.tracks.length - 1; prDirty(); }
    else pr.track = Number(v);
    pr.sel = new Set();
    prRender();
  });
  $("prTrack").querySelector(".cur").textContent = (pr.track + 1) + " · " + prTr().name;
  fxDd($("prSnap"), PR_SNAPS.map(x => ({ v: x.v, label: t(x.label) })), v => { pr.snap = v; prSavePrefs(); prRender(); });
  $("prSnap").querySelector(".cur").textContent = t((PR_SNAPS.find(x => x.v === pr.snap) || PR_SNAPS[2]).label);
  fxDd($("prVoice"), PR_VOICES.map(x => ({ v: x.v, label: t(x.label) })), v => { pr.voice = v; prSavePrefs(); prRender(); });
  $("prVoice").querySelector(".cur").textContent = t((PR_VOICES.find(x => x.v === pr.voice) || PR_VOICES[0]).label);
  const outs = [{ v: "", label: t("No MIDI out") }].concat(pr.midi ? [...pr.midi.outputs.values()].map(o => ({ v: o.id, label: o.name })) : []).concat(pr.midi ? [] : [{ v: "ask", label: t("Connect MIDI out…") }]);
  fxDd($("prOut"), outs, async v => { if (v === "ask") { await prMidiAccess(); pr.out = ""; } else pr.out = v; prSavePrefs(); prRender(); });
  const cur = outs.find(o => o.v === pr.out);
  $("prOut").querySelector(".cur").textContent = cur ? cur.label : t("No MIDI out");
  document.querySelectorAll("#prTool button").forEach(b => b.classList.toggle("on", b.dataset.v === pr.tool));
  if (document.activeElement !== $("prBpm")) $("prBpm").value = String(prBpm());
  $("prBpm").disabled = s.tempos.length > 1;
  $("prBpm").title = s.tempos.length > 1 ? t("This file changes tempo; the tempo map is kept as it is.") : t("Tempo");
  $("prPlay").textContent = pr.play ? t("stop") : t("play");
  $("prLoop").classList.toggle("on", pr.loopOn);
  $("prUndo").disabled = !pr.hist.length;
  $("prRedo").disabled = !pr.fut.length;
  const a = pr.audio;
  $("prAudioRow").classList.toggle("hidden", !a);
  if (a) { $("prAudio").classList.toggle("on", pr.audioOn); $("prAudio").textContent = t("audio") + ": " + a.name; $("prAudioLvl").value = String(Math.round(pr.audioLvl * 100)); }
  const tr = prTr();
  $("prMute").classList.toggle("on", tr.mute);
  $("prInfo").textContent = t("{n} notes").replace("{n}", tr.notes.length) + (pr.sel.size ? " · " + t("{n} selected").replace("{n}", pr.sel.size) : "") + " · " + fmtDur(prSec(prLen()));
}

function prDraw() {
  const cv = $("prCv"), { g, W, H } = scFit(cv), G = prGeom(), s = pr.s, v = pr.view;
  g.fillStyle = TH.canvas;
  g.fillRect(0, 0, W, H);
  const p0 = Math.max(0, prYP(G.vy)), p1 = Math.min(127, v.top);
  for (let p = p0; p <= p1; p++) {
    const y = prY(p), black = [1, 3, 6, 8, 10].includes(p % 12);
    g.fillStyle = black ? TH.laneA : TH.laneB;
    g.fillRect(PR_KEYW, y, G.gw, v.kh);
    if (p % 12 === 0) { g.fillStyle = tw(0.08); g.fillRect(PR_KEYW, y + v.kh - 1, G.gw, 1); }
  }
  const t0 = prXT(PR_KEYW), t1 = prXT(W), bar = prBar(), beat = s.ppq * 4 / s.ts[1], grid = prGrid();
  const lines = (step, col) => { if (step * v.ppx < 5) return; for (let k = Math.floor(t0 / step) * step; k <= t1; k += step) { const x = Math.round(prX(k)) + 0.5; if (x < PR_KEYW) continue; g.strokeStyle = col; g.beginPath(); g.moveTo(x, PR_RULER); g.lineTo(x, H); g.stroke(); } };
  g.lineWidth = 1;
  if (grid) lines(grid, tw(0.03));
  lines(beat, tw(0.07));
  lines(bar, tw(0.16));
  if (pr.audio && pr.audioOn) {
    const a = pr.audio, src = s.source;
    g.fillStyle = tc("ggold", 0.12);
    const mid = PR_RULER + G.gh / 2, amp = G.gh / 2 - 4;
    for (let x = PR_KEYW; x < W; x++) {
      const sec = prSec(prXT(x)), i = Math.floor(sec * a.sr / 256);
      if (i < 0 || i >= a.env.length) continue;
      const h = Math.min(1, a.env[i]) * amp;
      g.fillRect(x, mid - h, 1, h * 2);
    }
    void src;
  }
  if (pr.loop) {
    const xa = prX(pr.loop.a), xb = prX(pr.loop.b);
    g.fillStyle = tc("ggold", pr.loopOn ? 0.1 : 0.04);
    g.fillRect(Math.max(PR_KEYW, xa), PR_RULER, Math.max(0, xb - Math.max(PR_KEYW, xa)), G.gh);
  }
  g.save();
  g.beginPath();
  g.rect(PR_KEYW, PR_RULER, G.gw, G.gh);
  g.clip();
  s.tracks.forEach((tr, i) => {
    if (i === pr.track) return;
    g.fillStyle = tc(PR_COLORS[i % PR_COLORS.length], 0.22);
    for (const n of tr.notes) { const x = prX(n.t), w = Math.max(2, n.d * v.ppx); if (x + w < PR_KEYW || x > W) continue; g.fillRect(x, prY(n.p) + 1, w, v.kh - 2); }
  });
  const tr = prTr(), col = PR_COLORS[pr.track % PR_COLORS.length];
  for (const n of tr.notes) {
    const x = prX(n.t), w = Math.max(3, n.d * v.ppx), y = prY(n.p);
    if (x + w < PR_KEYW || x > W || y > G.vy || y + v.kh < PR_RULER) continue;
    const on = pr.sel.has(n.id);
    g.fillStyle = tc(col, tr.mute ? 0.35 : 0.45 + 0.55 * n.v / 127);
    g.fillRect(x, y + 1, w, v.kh - 2);
    if (on) { g.strokeStyle = TH.white; g.lineWidth = 1.5; g.strokeRect(x + 0.75, y + 1.75, w - 1.5, v.kh - 3.5); }
    if (v.kh >= 11 && w > 26) { g.fillStyle = "rgba(0,0,0,.65)"; g.font = thFont(8); g.textBaseline = "middle"; g.textAlign = "left"; g.fillText(mdName(n.p), x + 3, y + v.kh / 2); }
  }
  if (pr.drag && pr.drag.kind === "band") {
    const d = pr.drag, x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1);
    g.strokeStyle = tc("ggold", 0.9);
    g.setLineDash([3, 3]);
    g.strokeRect(x + 0.5, y + 0.5, Math.abs(d.x1 - d.x0), Math.abs(d.y1 - d.y0));
    g.setLineDash([]);
  }
  g.restore();
  g.fillStyle = "#d9d3c8";
  g.fillRect(0, PR_RULER, PR_KEYW, G.gh);
  for (let p = p0; p <= p1; p++) {
    const y = prY(p), m = p % 12;
    if ([1, 3, 6, 8, 10].includes(m)) { g.fillStyle = "#1b1814"; g.fillRect(0, y + 1, PR_KEYW * 0.6, v.kh - 2); }
    if (m === 0 || m === 5) { g.fillStyle = "#9a948a"; g.fillRect(0, y + v.kh - 0.5, PR_KEYW, 1); }
    if (m === 0 && v.kh >= 7) { g.fillStyle = "#3a352f"; g.font = thFont(8); g.textAlign = "right"; g.textBaseline = "middle"; g.fillText(mdName(p), PR_KEYW - 3, y + v.kh / 2); }
  }
  g.fillStyle = TH.line;
  g.fillRect(PR_KEYW - 1, PR_RULER, 1, G.gh);
  g.fillStyle = TH.panel;
  g.fillRect(0, 0, W, PR_RULER);
  g.font = thFont(9);
  g.textAlign = "left";
  g.textBaseline = "middle";
  const bstep = bar * Math.max(1, Math.pow(2, Math.ceil(Math.log2(Math.max(1, 60 / (bar * v.ppx))))));
  for (let k = Math.floor(t0 / bstep) * bstep; k <= t1; k += bstep) {
    const x = prX(k);
    if (x < PR_KEYW - 1) continue;
    g.fillStyle = TH.glabel;
    g.fillText(String(Math.round(k / bar) + 1), x + 3, PR_RULER / 2);
    g.fillStyle = tw(0.2);
    g.fillRect(Math.round(x), PR_RULER - 6, 1, 6);
  }
  if (pr.loop) { g.fillStyle = tc("ggold", pr.loopOn ? 0.8 : 0.35); g.fillRect(Math.max(PR_KEYW, prX(pr.loop.a)), PR_RULER - 3, Math.max(0, prX(pr.loop.b) - Math.max(PR_KEYW, prX(pr.loop.a))), 3); }
  g.fillStyle = TH.shade;
  g.fillRect(0, G.vy, W, PR_VEL);
  g.fillStyle = tw(0.12);
  g.fillRect(0, G.vy, W, 1);
  g.fillStyle = TH.glabel;
  g.font = thFont(8);
  g.textAlign = "left";
  g.fillText(t("velocity"), 4, G.vy + 10);
  for (const n of tr.notes) {
    const x = prX(n.t);
    if (x < PR_KEYW || x > W) continue;
    const h = (PR_VEL - 8) * n.v / 127;
    g.fillStyle = pr.sel.has(n.id) ? TH.white : tc(col, 0.8);
    g.fillRect(Math.round(x), G.vy + PR_VEL - 2 - h, 3, h);
  }
  const hx = prX(pr.play ? prNowTick() : pr.head);
  if (hx >= PR_KEYW && hx <= W) { g.fillStyle = TH.pink; g.fillRect(Math.round(hx), 0, 1.5, H); }
}

function prHit(x, y) {
  const tr = prTr(), p = prYP(y), tk = prXT(x);
  for (let i = tr.notes.length - 1; i >= 0; i--) {
    const n = tr.notes[i];
    if (n.p !== p) continue;
    const xa = prX(n.t), xb = xa + Math.max(3, n.d * pr.view.ppx);
    if (x >= xa && x <= xb) return { n, edge: xb - x <= Math.min(6, (xb - xa) / 3) };
  }
  void tk;
  return null;
}

function prDown(e) {
  if (!pr.open) return;
  const cv = $("prCv"), r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, G = prGeom(), tr = prTr();
  cv.setPointerCapture(e.pointerId);
  if (y < PR_RULER) {
    const tk = Math.max(0, prSnapT(prXT(x)));
    pr.drag = { kind: "ruler", t0: tk, moved: false };
    return;
  }
  if (x < PR_KEYW && y < G.vy) { const p = prYP(y); prAudition(p, 100); pr.drag = { kind: "keys", p }; return; }
  if (y >= G.vy) {
    const tk = prXT(x), hit = tr.notes.filter(n => Math.abs(prX(n.t) - x) <= 4);
    if (!hit.length) return;
    prPush();
    pr.drag = { kind: "vel", notes: pr.sel.has(hit[0].id) ? tr.notes.filter(n => pr.sel.has(n.id)) : hit, y0: y };
    void tk;
    prVel(y);
    return;
  }
  const h = prHit(x, y);
  if (pr.tool === "erase") {
    if (h) { prPush(); tr.notes.splice(tr.notes.indexOf(h.n), 1); pr.sel.delete(h.n.id); prDirty(); prRender(); }
    pr.drag = { kind: "erase" };
    return;
  }
  if (h) {
    if (e.shiftKey) { if (pr.sel.has(h.n.id)) pr.sel.delete(h.n.id); else pr.sel.add(h.n.id); }
    else if (!pr.sel.has(h.n.id)) pr.sel = new Set([h.n.id]);
    prPush();
    const notes = tr.notes.filter(n => pr.sel.has(n.id));
    pr.drag = { kind: h.edge ? "size" : "move", x0: x, y0: y, base: notes.map(n => ({ n, t: n.t, p: n.p, d: n.d })), lead: h.n, moved: false };
    if (!h.edge) prAudition(h.n.p, h.n.v);
    prRender();
    return;
  }
  if (pr.tool === "draw") {
    prPush();
    const g = prGrid() || pr.s.ppq / 4, tk = Math.max(0, g ? Math.floor(prXT(x) / g) * g : Math.round(prXT(x))), p = prYP(y);
    if (p < 0 || p > 127) return;
    const n = { id: pr.s.nid++, p, t: tk, d: g, v: 96, ch: tr.ch };
    tr.notes.push(n);
    tr.notes.sort((a, b) => a.t - b.t || a.p - b.p);
    pr.sel = new Set([n.id]);
    pr.drag = { kind: "size", x0: x, y0: y, base: [{ n, t: n.t, p: n.p, d: n.d }], lead: n, moved: true, fresh: true };
    prAudition(p, 96);
    prDirty();
    prRender();
    return;
  }
  if (!e.shiftKey) pr.sel = new Set();
  pr.drag = { kind: "band", x0: x, y0: y, x1: x, y1: y, keep: new Set(pr.sel) };
  prRender();
}

function prDbl(e) {
  if (!pr.open || pr.tool !== "select") return;
  const r = $("prCv").getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top, G = prGeom(), tr = prTr();
  if (x < PR_KEYW || y < PR_RULER || y >= G.vy || prHit(x, y)) return;
  const g = prGrid() || pr.s.ppq / 4, tk = Math.max(0, Math.floor(prXT(x) / g) * g), p = prYP(y);
  if (p < 0 || p > 127) return;
  prPush();
  const n = { id: pr.s.nid++, p, t: tk, d: g, v: 96, ch: tr.ch };
  tr.notes.push(n);
  tr.notes.sort((a, b) => a.t - b.t || a.p - b.p);
  pr.sel = new Set([n.id]);
  pr.drag = null;
  prAudition(p, 96);
  prDirty();
  prRender();
}

function prVel(y) {
  const G = prGeom(), v = Math.max(1, Math.min(127, Math.round((G.vy + PR_VEL - 2 - y) / (PR_VEL - 8) * 127)));
  for (const n of pr.drag.notes) n.v = v;
  prRender();
}

function prMove(e) {
  const d = pr.drag;
  const cv = $("prCv"), r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
  if (!d) {
    if (!pr.open) return;
    const h = y > PR_RULER && y < prGeom().vy && x > PR_KEYW ? prHit(x, y) : null;
    cv.style.cursor = h ? (h.edge ? "ew-resize" : "grab") : pr.tool === "draw" ? "crosshair" : pr.tool === "erase" ? "not-allowed" : "default";
    return;
  }
  if (d.kind === "ruler") {
    const tk = Math.max(0, prSnapT(prXT(x)));
    if (Math.abs(tk - d.t0) > 0 && Math.abs(x - prX(d.t0)) > 4) { d.moved = true; pr.loop = { a: Math.min(d.t0, tk), b: Math.max(d.t0, tk) }; pr.loopOn = true; }
    prRender();
    return;
  }
  if (d.kind === "vel") { prVel(y); return; }
  if (d.kind === "erase") { const h = prHit(x, y); if (h) { const tr = prTr(); tr.notes.splice(tr.notes.indexOf(h.n), 1); prDirty(); prRender(); } return; }
  if (d.kind === "band") {
    d.x1 = x; d.y1 = y;
    const ta = prXT(Math.min(d.x0, x)), tb = prXT(Math.max(d.x0, x)), pa = prYP(Math.max(d.y0, y)), pb = prYP(Math.min(d.y0, y));
    pr.sel = new Set(d.keep);
    for (const n of prTr().notes) if (n.t + n.d >= ta && n.t <= tb && n.p >= pa && n.p <= pb) pr.sel.add(n.id);
    prRender();
    return;
  }
  const g = prGrid();
  const dt = (x - d.x0) / pr.view.ppx;
  if (d.kind === "move") {
    const dp = Math.round((d.y0 - y) / pr.view.kh), lead = d.base.find(b => b.n === d.lead);
    const nt = g && !e.altKey ? Math.round((lead.t + dt) / g) * g : Math.round(lead.t + dt), shift = Math.max(-Math.min(...d.base.map(b => b.t)), nt - lead.t);
    const dpc = Math.max(-Math.min(...d.base.map(b => b.p)), Math.min(127 - Math.max(...d.base.map(b => b.p)), dp));
    if (shift || dpc) d.moved = true;
    const pitchChanged = d.base.some(b => b.n.p !== b.p + dpc);
    for (const b of d.base) { b.n.t = b.t + shift; b.n.p = b.p + dpc; }
    if (pitchChanged && dpc !== d.lastDp) prAudition(d.lead.p, d.lead.v);
    d.lastDp = dpc;
  } else {
    for (const b of d.base) {
      const end = b.t + b.d + dt, se = g && !e.altKey ? Math.round(end / g) * g : Math.round(end);
      b.n.d = Math.max(g && !e.altKey ? g : 10, se - b.t);
    }
    d.moved = true;
  }
  prRender();
}

function prUp() {
  const d = pr.drag;
  pr.drag = null;
  if (!d) return;
  if (d.kind === "ruler") {
    if (!d.moved) { pr.head = d.t0; if (pr.play) prStart(d.t0); }
    prRender();
    return;
  }
  if (d.kind === "vel" || d.kind === "erase") { prDirty(); prRender(); return; }
  if (d.kind === "move" || d.kind === "size") {
    if (!d.moved) pr.hist.pop();
    else { prTr().notes.sort((a, b) => a.t - b.t || a.p - b.p); prDirty(); }
  }
  prRender();
}

function prWheel(e) {
  if (!pr.open) return;
  e.preventDefault();
  const r = $("prCv").getBoundingClientRect(), x = e.clientX - r.left;
  if (e.ctrlKey || e.metaKey) {
    const at = prXT(x), k = Math.exp(-e.deltaY * 0.002);
    pr.view.ppx = Math.max(0.005, Math.min(2, pr.view.ppx * k));
    pr.view.x = Math.max(0, at - (x - PR_KEYW) / pr.view.ppx);
  } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
    pr.view.x = Math.max(0, pr.view.x + (e.deltaX || e.deltaY) / pr.view.ppx);
  } else if (e.altKey) {
    pr.view.kh = Math.max(5, Math.min(28, pr.view.kh * Math.exp(-e.deltaY * 0.002)));
  } else {
    pr.view.top = Math.max(12, Math.min(127, pr.view.top - Math.sign(e.deltaY) * Math.max(1, Math.round(Math.abs(e.deltaY) / 40))));
  }
  prDraw();
}

function prSelNotes() { return prTr().notes.filter(n => pr.sel.has(n.id)); }

function prKey(e) {
  if (!pr.open || e.target.closest("input, textarea, #dlg")) return;
  const k = e.key, mod = e.ctrlKey || e.metaKey, tr = prTr(), sel = prSelNotes();
  let done = true;
  if (k === "Escape") { if (pr.sel.size) pr.sel = new Set(); else prClose(); }
  else if (k === " ") { if (pr.play) prStop(); else prStart(pr.head); }
  else if (mod && k.toLowerCase() === "z") { if (e.shiftKey) prRedo(); else prUndo(); }
  else if (mod && k.toLowerCase() === "y") prRedo();
  else if (mod && k.toLowerCase() === "a") pr.sel = new Set(tr.notes.map(n => n.id));
  else if (mod && (k.toLowerCase() === "c" || k.toLowerCase() === "x") && sel.length) {
    const t0 = Math.min(...sel.map(n => n.t));
    pr.clip = sel.map(n => ({ p: n.p, t: n.t - t0, d: n.d, v: n.v }));
    if (k.toLowerCase() === "x") { prPush(); tr.notes = tr.notes.filter(n => !pr.sel.has(n.id)); pr.sel = new Set(); prDirty(); }
  } else if (mod && k.toLowerCase() === "v" && pr.clip) {
    prPush();
    const at = prSnapT(pr.head), ids = [];
    for (const c of pr.clip) { const n = { id: pr.s.nid++, p: c.p, t: at + c.t, d: c.d, v: c.v, ch: tr.ch }; tr.notes.push(n); ids.push(n.id); }
    tr.notes.sort((a, b) => a.t - b.t || a.p - b.p);
    pr.sel = new Set(ids);
    prDirty();
  } else if ((k === "Delete" || k === "Backspace") && sel.length) { prPush(); tr.notes = tr.notes.filter(n => !pr.sel.has(n.id)); pr.sel = new Set(); prDirty(); }
  else if ((k === "ArrowUp" || k === "ArrowDown") && sel.length) {
    const dp = (k === "ArrowUp" ? 1 : -1) * (e.shiftKey ? 12 : 1);
    if (sel.every(n => n.p + dp >= 0 && n.p + dp <= 127)) { prPush(); for (const n of sel) n.p += dp; prAudition(sel[0].p, sel[0].v); prDirty(); }
  } else if ((k === "ArrowLeft" || k === "ArrowRight") && sel.length) {
    const g = prGrid() || pr.s.ppq / 4, dt = (k === "ArrowRight" ? 1 : -1) * (e.shiftKey ? prBar() : g);
    if (sel.every(n => n.t + dt >= 0)) { prPush(); for (const n of sel) n.t += dt; tr.notes.sort((a, b) => a.t - b.t || a.p - b.p); prDirty(); }
  } else if (k.toLowerCase() === "q" && !mod) prQuantize();
  else if (k.toLowerCase() === "v" && !mod) pr.tool = "select";
  else if (k.toLowerCase() === "b" && !mod) pr.tool = "draw";
  else if (k.toLowerCase() === "e" && !mod) pr.tool = "erase";
  else if (k.toLowerCase() === "l" && !mod) pr.loopOn = !pr.loopOn && !!pr.loop;
  else if (k === "Home") { pr.head = 0; pr.view.x = 0; if (pr.play) prStart(0); }
  else done = false;
  if (done) { e.preventDefault(); prRender(); }
  e.stopPropagation();
}

function prQuantize() {
  const g = prGrid(), notes = pr.sel.size ? prSelNotes() : prTr().notes;
  if (!g || !notes.length) return;
  prPush();
  for (const n of notes) {
    const a = Math.round(n.t / g) * g, b = Math.max(a + g, Math.round((n.t + n.d) / g) * g);
    n.t = a;
    n.d = b - a;
  }
  prTr().notes.sort((a, b) => a.t - b.t || a.p - b.p);
  prDirty();
  prRender();
  flash(t("Quantized {n} notes to {g}").replace("{n}", notes.length).replace("{g}", t((PR_SNAPS.find(x => x.v === pr.snap) || {}).label || "")));
}

function prSavePrefs() {
  try { localStorage.setItem("studioPianoRoll", JSON.stringify({ snap: pr.snap, voice: pr.voice, out: pr.out, audioLvl: pr.audioLvl })); } catch {}
}

function prLoadPrefs() {
  try {
    const v = JSON.parse(localStorage.getItem("studioPianoRoll") || "null") || {};
    if (PR_SNAPS.some(x => x.v === v.snap)) pr.snap = v.snap;
    if (PR_VOICES.some(x => x.v === v.voice)) pr.voice = v.voice;
    if (typeof v.out === "string") pr.out = v.out;
    if (Number.isFinite(v.audioLvl)) pr.audioLvl = Math.max(0, Math.min(1, v.audioLvl));
  } catch {}
}

async function prMidiAccess() {
  if (pr.midi) return pr.midi;
  if (!navigator.requestMIDIAccess) { await tell(t("This browser has no Web MIDI. Chrome and Edge have it.")); return null; }
  try { pr.midi = await navigator.requestMIDIAccess(); pr.midi.onstatechange = () => { if (pr.open) prToolbar(); }; }
  catch { await tell(t("MIDI access was not allowed.")); return null; }
  return pr.midi;
}

function prOutPort() {
  return pr.midi && pr.out ? pr.midi.outputs.get(pr.out) || null : null;
}

function prCtx() {
  if (!pr.ctx) {
    pr.ctx = new AudioContext();
    pr.bus = pr.ctx.createDynamicsCompressor();
    pr.bus.threshold.value = -12;
    pr.bus.ratio.value = 4;
    pr.master = pr.ctx.createGain();
    pr.master.gain.value = 0.5;
    pr.bus.connect(pr.master).connect(pr.ctx.destination);
  }
  pr.ctx.resume();
  return pr.ctx;
}

function prVoice(p, v, when, dur, ch) {
  const ctx = prCtx(), f = 440 * Math.pow(2, (p - 69) / 12), amp = 0.06 + 0.24 * (v / 127) ** 1.5, end = when + dur;
  const out = ctx.createGain();
  out.gain.value = 0;
  out.connect(pr.bus);
  const nodes = [out];
  if (ch === 9) {
    const len = Math.floor(ctx.sampleRate * 0.3), buf = ctx.createBuffer(1, len, ctx.sampleRate), d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.exp(-i / (ctx.sampleRate * (p < 40 ? 0.08 : p < 45 ? 0.05 : 0.02)));
    const s = ctx.createBufferSource(), fl = ctx.createBiquadFilter();
    s.buffer = buf;
    fl.type = p < 40 ? "lowpass" : p < 45 ? "bandpass" : "highpass";
    fl.frequency.value = p < 40 ? 180 : p < 45 ? 1800 : 7000;
    s.connect(fl).connect(out);
    if (p < 40) { const o = ctx.createOscillator(), og = ctx.createGain(); o.frequency.setValueAtTime(120, when); o.frequency.exponentialRampToValueAtTime(45, when + 0.15); og.gain.setValueAtTime(amp * 3, when); og.gain.exponentialRampToValueAtTime(0.001, when + 0.25); o.connect(og).connect(out); o.start(when); o.stop(when + 0.3); nodes.push(o, og); }
    out.gain.setValueAtTime(amp * 2.5, when);
    s.start(when);
    s.stop(when + 0.3);
    nodes.push(s, fl);
    setTimeout(() => nodes.forEach(n => n.disconnect()), (when - ctx.currentTime + 0.5) * 1000);
    return { stop: () => { try { s.stop(); } catch {} } };
  }
  const oscs = [];
  const add = (type, mult, g) => { const o = ctx.createOscillator(), og = ctx.createGain(); o.type = type; o.frequency.value = f * mult; og.gain.value = g; o.connect(og).connect(out); oscs.push(o); nodes.push(o, og); };
  let rel = 0.12;
  if (pr.voice === "lead") {
    const fl = ctx.createBiquadFilter();
    fl.type = "lowpass";
    fl.frequency.value = 1200 + 3000 * v / 127;
    out.disconnect();
    out.connect(fl).connect(pr.bus);
    nodes.push(fl);
    add("sawtooth", 1, 0.5);
    add("sawtooth", 1.004, 0.35);
    out.gain.setValueAtTime(0, when);
    out.gain.linearRampToValueAtTime(amp, when + 0.01);
    out.gain.setTargetAtTime(amp * 0.7, when + 0.01, 0.2);
  } else if (pr.voice === "sine") {
    add("sine", 1, 1);
    out.gain.setValueAtTime(0, when);
    out.gain.linearRampToValueAtTime(amp, when + 0.01);
    rel = 0.06;
  } else {
    add("sine", 1, 0.8);
    add("triangle", 2, 0.18);
    add("sine", 3, 0.06);
    out.gain.setValueAtTime(0, when);
    out.gain.linearRampToValueAtTime(amp * 1.4, when + 0.006);
    out.gain.setTargetAtTime(amp * 0.25, when + 0.006, 0.45);
    rel = 0.25;
  }
  out.gain.setTargetAtTime(0, end, rel / 3);
  for (const o of oscs) { o.start(when); o.stop(end + rel * 2); }
  oscs[0].onended = () => nodes.forEach(n => n.disconnect());
  return { stop: at => { const t1 = at || ctx.currentTime; out.gain.cancelScheduledValues(t1); out.gain.setTargetAtTime(0, t1, 0.01); for (const o of oscs) { try { o.stop(t1 + 0.05); } catch {} } } };
}

function prAudition(p, v) {
  const ch = prTr().ch, port = prOutPort();
  if (port) { port.send([0x90 | ch, p, v]); port.send([0x80 | ch, p, 0], performance.now() + 250); return; }
  prVoice(p, v, prCtx().currentTime + 0.005, 0.25, ch);
}

function prQueue(fromTick, toTick) {
  const out = [], solo = pr.s.tracks;
  solo.forEach(tr => {
    if (tr.mute) return;
    for (const n of tr.notes) if (n.t >= fromTick && n.t < toTick) out.push({ n, ch: n.ch === undefined ? tr.ch : n.ch });
  });
  return out.sort((a, b) => a.n.t - b.n.t);
}

function prNowTick() {
  const P = pr.play;
  if (!P) return pr.head;
  const el = Math.max(0, pr.ctx.currentTime - P.t0);
  if (!P.loop) return prTick(P.s0 + el);
  const first = P.loopB - P.s0;
  return prTick(el < first ? P.s0 + el : P.loopA + ((el - first) % P.loopSec));
}

function prStart(fromTick) {
  prStop(true);
  const ctx = prCtx(), loop = pr.loopOn && pr.loop && pr.loop.b > pr.loop.a ? pr.loop : null;
  let s0 = prSec(fromTick || 0);
  if (loop && (fromTick < loop.a || fromTick >= loop.b)) s0 = prSec(loop.a);
  const t0 = ctx.currentTime + 0.06;
  const P = { t0, s0, loop: !!loop, loopA: loop ? prSec(loop.a) : 0, loopB: loop ? prSec(loop.b) : 0, voices: [], sent: [], audio: [], base: t0 - s0, next: s0, end: prSec(prLen()), timer: 0, raf: 0 };
  P.loopSec = P.loopB - P.loopA;
  P.segEnd = P.loop ? P.loopB : P.end + 0.3;
  pr.play = P;
  prAudioAt(P, s0, t0);
  const tick = () => {
    if (pr.play !== P) return;
    const horizon = ctx.currentTime + 0.2;
    while (P.base + P.next < horizon) {
      const chunkEnd = Math.min(P.segEnd, P.next + 0.25);
      for (const it of prQueue(prTick(P.next) - 1e-6, prTick(chunkEnd) - 1e-6)) prEmit(P, it, P.base);
      P.next = chunkEnd;
      if (P.next < P.segEnd - 1e-9) continue;
      if (!P.loop) {
        const left = (P.base + P.segEnd - ctx.currentTime) * 1000;
        setTimeout(() => { if (pr.play === P) { prStop(true); pr.head = 0; prRender(); } }, Math.max(0, left));
        return;
      }
      const wrap = P.base + P.loopB;
      P.base += P.loopB - P.loopA;
      P.next = P.loopA;
      prAudioAt(P, P.loopA, wrap);
    }
    P.timer = setTimeout(tick, 25);
  };
  tick();
  const anim = () => { if (pr.play !== P) return; prKeepHead(); prDraw(); P.raf = requestAnimationFrame(anim); };
  P.raf = requestAnimationFrame(anim);
  prToolbar();
}

function prEmit(P, it, base) {
  const n = it.n, s = prSec(n.t), e = Math.min(prSec(n.t + n.d), P.loop ? P.loopB : Infinity), when = base + s, dur = Math.max(0.02, e - s);
  if (when < pr.ctx.currentTime - 0.01) return;
  P.count = (P.count || 0) + 1;
  const port = prOutPort();
  if (port) {
    const pn = performance.now() + (when - pr.ctx.currentTime) * 1000;
    port.send([0x90 | it.ch, n.p, Math.max(1, n.v)], pn);
    port.send([0x80 | it.ch, n.p, 0], pn + dur * 1000);
    P.sent.push(it.ch);
    return;
  }
  P.voices.push(prVoice(n.p, n.v, when, dur, it.ch));
  if (P.voices.length > 256) P.voices.splice(0, 128);
}

function prAudioAt(P, songSec, when) {
  const a = pr.audio;
  if (!a || !pr.audioOn || !pr.s.source) return;
  const ctx = pr.ctx;
  if (!a.buf || a.buf.sampleRate !== a.sr) { a.buf = ctx.createBuffer(a.planes.length, a.n, a.sr); a.planes.forEach((q, c) => a.buf.copyToChannel(q, c)); }
  for (const x of P.audio) { try { x.s.stop(Math.max(ctx.currentTime, when)); } catch {} }
  const s = ctx.createBufferSource(), g = ctx.createGain();
  s.buffer = a.buf;
  g.gain.value = pr.audioLvl;
  s.connect(g).connect(ctx.destination);
  if (songSec < a.n / a.sr) s.start(Math.max(ctx.currentTime, when), songSec, P.loop ? Math.max(0.01, P.loopB - songSec) : undefined);
  P.audio.push({ s, g });
}

function prStop(quiet) {
  const P = pr.play;
  if (!P) return;
  pr.head = Math.max(0, Math.round(prNowTick()));
  pr.play = null;
  clearTimeout(P.timer);
  cancelAnimationFrame(P.raf);
  const now = pr.ctx.currentTime;
  for (const v of P.voices) v.stop(now);
  for (const x of P.audio) { try { x.s.stop(); } catch {} }
  const port = prOutPort();
  if (port) { port.clear && port.clear(); for (const ch of new Set(P.sent)) { port.send([0xb0 | ch, 123, 0]); port.send([0xb0 | ch, 120, 0]); } }
  if (!quiet) prRender();
}

function prResched() {
  if (!pr.play) return;
  const at = Math.round(prNowTick());
  prStart(at);
}

function prKeepHead() {
  const tk = prNowTick(), x = prX(tk), G = prGeom();
  if (x > PR_KEYW + G.gw * 0.92 || x < PR_KEYW) pr.view.x = Math.max(0, tk - (G.gw * 0.1) / pr.view.ppx);
}

function prExportName() { return (xpClean(pr.s.name) || "midi") + ".mid"; }

function prDownload() {
  const bytes = prWrite(pr.s), a = document.createElement("a"), url = URL.createObjectURL(new Blob([bytes], { type: "audio/midi" }));
  a.href = url;
  a.download = prExportName();
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
  flash(t("Saved") + " " + a.download);
}

async function prLocker() {
  const bytes = prWrite(pr.s);
  $("prLocker").disabled = true;
  try {
    const path = await mdUpload(bytes, prExportName());
    flash(t("Saved in the Locker") + ": " + path);
  } catch (e) { tell(mdErrText(String(e.message || e))); }
  finally { $("prLocker").disabled = false; }
}

async function prRename() {
  const name = String((await askText(t("Rename the MIDI"), pr.s.name)) || "").trim();
  if (!name) return;
  pr.s.name = name.slice(0, 120);
  prDirty();
  prRender();
}

async function prTrackDlg() {
  const tr = prTr(), multi = pr.s.tracks.length > 1;
  const v = await askForm(t("Track"), `<label class="dfield"><span>${esc(t("Name"))}</span><input name="name" value="${esc(tr.name)}" spellcheck="false" autocomplete="off"></label><label class="dfield"><span>${esc(t("MIDI channel"))}</span><input name="ch" value="${tr.ch + 1}" inputmode="numeric"></label><label class="dfield"><span>${esc(t("Program (instrument number)"))}</span><input name="program" value="${tr.program + 1}" inputmode="numeric"></label>${multi ? `<label class="sesdoc"><input type="checkbox" name="del"><span>${esc(t("delete this track"))}</span></label>` : ""}<div class="dnote">${esc(t("Channel 10 plays drums. The program is sent to MIDI out; the built-in synth plays its own voice."))}</div>`, { ok: t("ok") });
  if (!v) return;
  prPush();
  if (v.del && multi) { pr.s.tracks.splice(pr.track, 1); pr.track = Math.max(0, pr.track - 1); }
  else {
    tr.name = String(v.name || tr.name).trim().slice(0, 80) || tr.name;
    const ch = Math.round(Number(v.ch)), pg = Math.round(Number(v.program));
    if (ch >= 1 && ch <= 16 && ch - 1 !== tr.ch) { tr.ch = ch - 1; for (const n of tr.notes) n.ch = tr.ch; }
    if (pg >= 1 && pg <= 128) tr.program = pg - 1;
  }
  pr.sel = new Set();
  prDirty();
  prRender();
}

function prSetBpm() {
  const v = Number(String($("prBpm").value).replace(",", "."));
  if (!(v >= 20 && v <= 400) || pr.s.tempos.length > 1) { prRender(); return; }
  prPush();
  if (pr.s.source && pr.audio) {
    const k = (60e6 / v) / pr.s.tempos[0].us;
    for (const tr of pr.s.tracks) for (const n of tr.notes) { const e = Math.round((n.t + n.d) / k); n.t = Math.round(n.t / k); n.d = Math.max(1, e - n.t); }
  }
  pr.s.tempos = [{ tick: 0, us: Math.round(60e6 / v) }];
  pr.segs = prSegs(pr.s);
  prDirty();
  prRender();
}

function wirePianoRoll() {
  prLoadPrefs();
  const cv = $("prCv");
  cv.addEventListener("pointerdown", prDown);
  cv.addEventListener("pointermove", prMove);
  cv.addEventListener("pointerup", prUp);
  cv.addEventListener("pointercancel", prUp);
  cv.addEventListener("wheel", prWheel, { passive: false });
  cv.addEventListener("dblclick", prDbl);
  cv.addEventListener("contextmenu", e => e.preventDefault());
  document.addEventListener("keydown", e => { if (pr.open) prKey(e); }, true);
  $("prX").addEventListener("click", () => prClose());
  $("prName").addEventListener("click", prRename);
  $("prTool").addEventListener("click", e => { const b = e.target.closest("button"); if (!b) return; pr.tool = b.dataset.v; prRender(); });
  $("prPlay").addEventListener("click", () => { if (pr.play) prStop(); else prStart(pr.head); });
  $("prLoop").addEventListener("click", () => { if (!pr.loop) { const b = prBar(); pr.loop = { a: Math.floor(pr.head / b) * b, b: Math.floor(pr.head / b) * b + b * 4 }; } pr.loopOn = !pr.loopOn; if (pr.play) prStart(Math.round(prNowTick())); prRender(); });
  $("prUndo").addEventListener("click", prUndo);
  $("prRedo").addEventListener("click", prRedo);
  $("prQuant").addEventListener("click", prQuantize);
  $("prTrackBtn").addEventListener("click", prTrackDlg);
  $("prMute").addEventListener("click", () => { prPush(); prTr().mute = !prTr().mute; prDirty(); prRender(); });
  $("prExport").addEventListener("click", prDownload);
  $("prLocker").addEventListener("click", prLocker);
  $("prBpm").addEventListener("change", prSetBpm);
  $("prBpm").addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); $("prBpm").blur(); } e.stopPropagation(); });
  $("prAudio").addEventListener("click", () => { pr.audioOn = !pr.audioOn; if (pr.play) prStart(Math.round(prNowTick())); prRender(); });
  $("prAudioLvl").addEventListener("input", () => { pr.audioLvl = Number($("prAudioLvl").value) / 100; if (pr.play) for (const x of pr.play.audio) x.g.gain.value = pr.audioLvl; prSavePrefs(); });
  $("prNew").addEventListener("click", prNewSong);
  $("prImport").addEventListener("click", () => $("prFile").click());
  $("prFile").addEventListener("change", e => { const f = e.target.files[0]; e.target.value = ""; if (f) prImportFile(f); });
  window.addEventListener("resize", () => { if (pr.open) prDraw(); });
  document.addEventListener("i18n", () => { if (pr.open) prRender(); });
}

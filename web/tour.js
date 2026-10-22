const TOUR_STEPS = [
  { part: "ext", pos: "center", title: "Studio for Chrome is ready", text: () => {
    const k = ex.keys || {}, base = t("Pin it with the puzzle piece in Chrome's toolbar. On any tab that plays sound, click it and choose Record this tab: Studio records the tab and plays it back while it records.");
    return k["rec-toggle"] && k["rec-marker"] ? base + " " + t("{k1} starts and stops a recording and {k2} sets a marker, even while you work in another app.").replace("{k1}", k["rec-toggle"]).replace("{k2}", k["rec-marker"]) : base;
  } },
  { part: "start", pos: "center", title: "Welcome to Delicate Studio", text: "Record, edit, repair and master audio in your browser: vinyl rips, guitar and vocal takes, interviews, anything you can plug in. This tour takes a minute, and the command palette brings it back whenever you want." },
  { part: "start", sel: "#empty .emptybtns", title: "Open a file", text: "Drop audio anywhere on the window or open it from your computer, your music library or your Locker. Studio works on its own copy; the original is never changed." },
  { part: "start", sel: "#recBtn", title: "Record", text: "The red dot records any input: a turntable through a phono preamp, a guitar or a microphone through an interface, or a browser tab. It can start when the needle drops and stop in the run-out groove, and markers you set while recording stay in the file." },
  { part: "start", sel: "#filesBtn", title: "Your files", text: "Everything you open or record is kept in this browser's storage, safe against crashes, and opens again where you left it. Library and Locker are one tab away." },
  { part: "start", sel: "#palBtn", title: "Command palette", text: "Every command by name — Match loudness, Noise Reduction, Convert to MIDI, Record — with its shortcut next to it. Type a time such as 1:23.5 to jump there." },
  { part: "start", sel: "#setbtn", title: "Settings", text: "Language, theme and text size, with a Large print theme for tired eyes, plus keys like Adobe Audition, Pro Tools or REAPER." },
  { part: "start", pos: "center", when: () => !ed.doc, title: "That's the start", text: "Open a file or press Record. When your first file opens, a few more steps show the editor." },
  { part: "edit", sel: "#wv", title: "Waveform", text: "Click to place the cursor, drag to select. The mouse wheel zooms, Shift with the wheel scrolls, and the overview above shows the whole file. Colours follow the sound: low pink, mid gold, high blue." },
  { part: "edit", sel: "#edTools", title: "Editing", text: "Undo, redo, cut, copy, paste, delete, silence, crop and insert silence. Drag the squares at the top corners of the waveform to fade in or out, and right-click for Process: reverse, invert, DC offset and the channel tools. Each edit is a step in History, and the work runs in the background, so even hour-long recordings stay quick." },
  { part: "edit", sel: "#specBtn", title: "Spectrogram", text: "Shows the frequencies below the waveform. Select by time, with a rectangle or a lasso, and paint out clicks and noises with the Spot Healing Brush." },
  { part: "edit", sel: "#dgBtn", title: "Repair", text: "Diagnostics finds clicks and clipping, Noise Reduction learns from a noise print, DeHummer removes mains hum, Loudness brings a vinyl rip up to digital levels, MIDI turns a melody into notes, and Tracks splits a side into tracks named from Discogs." },
  { part: "edit", sel: "#locsBtn", title: "Markers and ranges", text: "Markers and ranges, including those set while recording, with names and times. Each range can be exported as its own track." },
  { part: "edit", sel: "#expBtn", title: "Export", text: "WAV and FLAC in the bit depth and sample rate you choose, several formats in one go, with dither — the whole file, the selection or each range, to your computer or the Locker. Tags, cover and markers go into the files; click the file name to edit the tags." },
  { part: "edit", sel: ".edfoot .transport", title: "Transport", text: "Space plays and stops; the loop button repeats the selection. The time display follows the playhead." },
  { part: "edit", sel: ".selpanel", title: "Exact times", text: "Type a start, an end or a duration to set the selection exactly, in time, samples or CD frames." },
  { part: "edit", sel: "#keysBtn", title: "Shortcuts", text: "This lists every shortcut, and the command palette changes any key. That's the tour — enjoy the session." },
];

const tour = { i: 0, el: null, on: false, list: [], parts: [] };

function tourSeen() {
  try { const v = JSON.parse(localStorage.getItem("studioTour") || "null"); return v && typeof v === "object" ? v : {}; } catch { return {}; }
}

function tourMark(parts) {
  const s = tourSeen();
  for (const p of parts) s[p] = 1;
  try { localStorage.setItem("studioTour", JSON.stringify(s)); } catch {}
}

function tourBuild() {
  if (tour.el) return;
  const el = document.createElement("div");
  el.id = "tour";
  el.className = "hidden";
  el.innerHTML = `<div class="tspot"></div><div class="tcard" role="dialog" aria-live="polite"><div class="tstep"></div><div class="ttitle"></div><div class="ttext"></div><div class="tbtns"><button class="outbtn tskip"></button><span class="grow"></span><button class="outbtn tprev"></button><button class="outbtn tnext"></button></div></div>`;
  document.body.appendChild(el);
  tour.el = el;
  el.querySelector(".tskip").addEventListener("click", () => tourEnd(true));
  el.querySelector(".tprev").addEventListener("click", () => tourGo(tour.i - 1));
  el.querySelector(".tnext").addEventListener("click", () => tourGo(tour.i + 1));
  el.addEventListener("keydown", e => {
    e.stopPropagation();
    if (e.key === "Escape") { e.preventDefault(); tourEnd(true); }
    else if (e.key === "ArrowRight") { e.preventDefault(); tourGo(tour.i + 1); }
    else if (e.key === "ArrowLeft") { e.preventDefault(); tourGo(tour.i - 1); }
  });
  window.addEventListener("resize", () => { if (tour.on) tourPlace(); });
  document.addEventListener("i18n", () => { if (tour.on) tourGo(tour.i); });
}

function tourVisible(sel) {
  const el = document.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? el : null;
}

function tourShows(s) {
  return s.pos === "center" || !!tourVisible(s.sel);
}

function tourGo(i) {
  const L = tour.list, dir = i >= tour.i ? 1 : -1;
  while (i >= 0 && i < L.length && !tourShows(L[i])) i += dir;
  if (i < 0) { i = 0; while (i < L.length && !tourShows(L[i])) i++; }
  if (i >= L.length) { tourEnd(false); return; }
  tour.i = i;
  const s = L[i], el = tour.el, target = s.pos === "center" ? null : tourVisible(s.sel);
  if (target) target.scrollIntoView({ block: "nearest", inline: "nearest" });
  const shown = L.filter(tourShows), at = shown.indexOf(s);
  el.querySelector(".tstep").textContent = (at + 1) + " / " + shown.length;
  el.querySelector(".ttitle").textContent = t(s.title);
  el.querySelector(".ttext").textContent = typeof s.text === "function" ? s.text() : t(s.text);
  el.querySelector(".tskip").textContent = t("skip tour");
  el.querySelector(".tprev").textContent = t("back");
  el.querySelector(".tprev").style.visibility = at <= 0 ? "hidden" : "";
  el.querySelector(".tnext").textContent = at === shown.length - 1 ? t("done") : t("next");
  requestAnimationFrame(() => { tourPlace(); el.querySelector(".tnext").focus(); });
}

function tourPlace() {
  const s = tour.list[tour.i], el = tour.el, spot = el.querySelector(".tspot"), card = el.querySelector(".tcard");
  const target = s.pos === "center" ? null : tourVisible(s.sel), W = window.innerWidth, H = window.innerHeight, m = 12;
  if (!target) {
    spot.style.cssText = "left:50%;top:50%;width:0;height:0;";
    card.style.left = Math.max(m, (W - card.offsetWidth) / 2) + "px";
    card.style.top = Math.max(m, (H - card.offsetHeight) / 2) + "px";
    return;
  }
  const r = target.getBoundingClientRect(), pad = 6, cw = card.offsetWidth, ch = card.offsetHeight;
  spot.style.cssText = `left:${r.left - pad}px;top:${r.top - pad}px;width:${r.width + pad * 2}px;height:${r.height + pad * 2}px;`;
  let x = r.left, y = r.bottom + 14;
  if (y + ch > H - m) y = r.top - ch - 14;
  if (y < m) { y = Math.max(m, Math.min(H - ch - m, r.top)); x = r.right + 14; if (x + cw > W - m) x = r.left - cw - 14; }
  card.style.left = Math.max(m, Math.min(W - cw - m, x)) + "px";
  card.style.top = Math.max(m, Math.min(H - ch - m, y)) + "px";
}

function tourStart(parts) {
  tourBuild();
  tour.parts = parts;
  tour.list = TOUR_STEPS.filter(s => parts.includes(s.part) && (!s.when || s.when()));
  if (!tour.list.some(tourShows)) return;
  closePopovers();
  tour.on = true;
  tour.i = 0;
  tour.el.classList.remove("hidden");
  tourGo(0);
}

function tourEnd(skip) {
  if (!tour.on) return;
  tour.on = false;
  tour.el.classList.add("hidden");
  tourMark(skip ? ["ext", "start", "edit", "skip"] : tour.parts);
}

function tourAll() {
  tourStart((ex.on ? ["ext"] : []).concat(ed.doc ? ["start", "edit"] : ["start"]));
}

function tourAuto() {
  return !navigator.webdriver && !window.matchMedia("(max-width:760px)").matches;
}

function tourFree() {
  return !tour.on && !rc.open && !document.querySelector("#settings:not(.hidden), #exp:not(.hidden), #dlg:not(.hidden), #pal:not(.hidden), #diag:not(.hidden), #busy:not(.hidden)");
}

function tourDoc() {
  const s = tourSeen();
  if (!tourAuto() || !s.start || s.edit || s.skip || tour.on) return;
  setTimeout(() => { if (ed.doc && tourFree()) tourStart(["edit"]); }, 700);
}

function wireTour() {
  $("tourBtn").addEventListener("click", () => { closeSettings(); tourAll(); });
}

function tourInit(welcome) {
  const s = tourSeen();
  if (welcome) { setTimeout(() => tourStart(s.start || s.skip ? ["ext"] : ["ext", "start"]), 600); return; }
  if (!tourAuto() || s.start || s.skip || ed.doc || (ed.docs && ed.docs.length)) return;
  setTimeout(() => { if (!ed.doc && tourFree()) tourStart(["start"]); }, 900);
}

const pv = { tok: location.pathname.split("/")[2] || "", data: null, secs: 0, seen: 0 };

function $(id) { return document.getElementById(id); }

function pvT(s) { const v = Math.max(0, Math.floor(s)), h = Math.floor(v / 3600), m = Math.floor(v / 60) % 60; return (h ? h + ":" + String(m).padStart(2, "0") : String(m)) + ":" + String(v % 60).padStart(2, "0"); }

async function pvLoad() {
  try {
    const r = await fetch("/api/studio/pub/" + encodeURIComponent(pv.tok), { cache: "no-store" });
    if (!r.ok) throw new Error(String(r.status));
    pv.data = await r.json();
  } catch { pv.data = null; }
}

function pvDraw() {
  const cv = $("pvCv"), D = pv.data;
  if (!cv || !D) return;
  const w = cv.clientWidth, h = cv.clientHeight, dpr = devicePixelRatio || 1;
  if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(h * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
  const g = cv.getContext("2d"), P = D.peaks || [], cs = getComputedStyle(document.body), now = $("pvAudio").currentTime || 0, x0 = pv.secs ? now / pv.secs * w : 0;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const gold = cs.getPropertyValue("--gold").trim() || "#c9a24a", dim = cs.getPropertyValue("--dim").trim() || "#5f5a52", pink = cs.getPropertyValue("--pink").trim() || "#DF39BB";
  for (let x = 0; x < w; x++) {
    const i = Math.floor(x / w * P.length), v = P[i] || 0, y = Math.max(1, v * (h / 2 - 6));
    g.fillStyle = x < x0 ? gold : dim;
    g.fillRect(x, h / 2 - y, 1, y * 2);
  }
  g.fillStyle = pink;
  for (const c of D.comments) { const x = pv.secs ? c.at / pv.secs * w : 0; g.fillRect(Math.round(x), 0, 2, 6); g.fillRect(Math.round(x), h - 6, 2, 6); }
  g.fillStyle = "#fff";
  g.fillRect(Math.round(x0), 0, 1, h);
}

function pvTime() {
  const a = $("pvAudio"), at = a.currentTime || 0;
  $("pvTime").textContent = pvT(at) + " / " + pvT(pv.secs);
  $("pvAt").textContent = t("at {t}").replace("{t}", pvT(at));
  $("pvPlay").querySelector(".ip").classList.toggle("hidden", !a.paused);
  $("pvPlay").querySelector(".is").classList.toggle("hidden", a.paused);
  pvDraw();
}

function pvSeek(s, play) {
  const a = $("pvAudio");
  a.currentTime = Math.max(0, Math.min(pv.secs, s));
  if (play) a.play().catch(() => {});
  pvTime();
}

function pvList() {
  const box = $("pvList"), D = pv.data;
  box.textContent = "";
  if (!D.comments.length) { box.appendChild(Object.assign(document.createElement("div"), { className: "snote", textContent: t("No comments yet. Play the track and write what you hear, at the moment you hear it.") })); return; }
  for (const c of D.comments) {
    const row = document.createElement("div");
    row.className = "pvc" + (c.done ? " done" : "");
    const tb = document.createElement("button");
    tb.type = "button";
    tb.className = "txt";
    tb.textContent = pvT(c.at);
    tb.addEventListener("click", () => pvSeek(c.at, true));
    const tx = document.createElement("span");
    tx.className = "pvct";
    const b = document.createElement("b");
    b.textContent = c.name + " ";
    tx.append(b, document.createTextNode(c.text));
    row.append(tb, tx);
    if (c.done) row.appendChild(Object.assign(document.createElement("span"), { className: "snote", textContent: " · " + t("done") }));
    box.appendChild(row);
  }
}

async function pvSend(e) {
  e.preventDefault();
  const text = $("pvText").value.trim(), name = $("pvWho").value.trim();
  if (!text) return;
  try { localStorage.setItem("reviewName", name); } catch {}
  $("pvSend").disabled = true;
  try {
    const r = await fetch("/api/studio/pub/" + encodeURIComponent(pv.tok) + "/comments", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name, at: $("pvAudio").currentTime || 0, text }) });
    if (!r.ok) throw new Error(String(r.status));
    const c = await r.json();
    pv.data.comments.push(c);
    pv.data.comments.sort((x, y) => x.at - y.at);
    $("pvText").value = "";
    pvList();
    pvDraw();
  } catch { alertBox(t("The comment could not be sent. Try again.")); }
  finally { $("pvSend").disabled = false; }
}

function alertBox(msg) {
  const n = $("pvAt");
  n.textContent = msg;
  n.classList.add("err");
  setTimeout(() => { n.classList.remove("err"); pvTime(); }, 4000);
}

async function pvPoll() {
  if (!pv.data || document.hidden) return;
  const before = pv.data.comments.length;
  const keep = pv.data;
  await pvLoad();
  if (!pv.data) { pv.data = keep; return; }
  if (pv.data.comments.length !== before) { pvList(); pvDraw(); }
}

async function pvStart() {
  if (typeof i18nInit === "function") { await i18nInit(); i18nPicker($("langReview"), { align: "end" }); }
  await pvLoad();
  if (!pv.data) { $("pvGone").classList.remove("hidden"); return; }
  const D = pv.data;
  pv.secs = D.secs;
  document.title = D.name + " · " + t("Review");
  $("pvName").textContent = D.name;
  $("pvExp").textContent = D.expires ? t("This link works until {d}.").replace("{d}", new Date(D.expires * 1000).toLocaleDateString(i18n.lang || undefined, { day: "numeric", month: "long", year: "numeric" })) : "";
  try { $("pvWho").value = localStorage.getItem("reviewName") || ""; } catch {}
  $("pvMain").classList.remove("hidden");
  const a = $("pvAudio");
  a.src = "/api/studio/pub/" + encodeURIComponent(pv.tok) + "/audio";
  a.addEventListener("timeupdate", pvTime);
  a.addEventListener("play", pvTime);
  a.addEventListener("pause", pvTime);
  $("pvPlay").addEventListener("click", () => { if (a.paused) a.play().catch(() => {}); else a.pause(); });
  $("pvCv").addEventListener("click", e => { const r = $("pvCv").getBoundingClientRect(); pvSeek((e.clientX - r.left) / r.width * pv.secs, !a.paused); });
  $("pvForm").addEventListener("submit", pvSend);
  $("pvText").addEventListener("keydown", e => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) pvSend(e); });
  document.addEventListener("keydown", e => { if (e.key === " " && !/INPUT|TEXTAREA|BUTTON/.test(document.activeElement.tagName)) { e.preventDefault(); $("pvPlay").click(); } });
  addEventListener("resize", pvDraw);
  (function loop() { if (!a.paused) pvDraw(); requestAnimationFrame(loop); })();
  pvList();
  pvTime();
  setInterval(pvPoll, 20000);
}

pvStart();

const STUDIO = "https://studio.delicateaudio.com/";
const $ = id => document.getElementById(id);
const M = (k, s) => chrome.i18n.getMessage(k, s) || k;
const P = { tab: null, state: null, err: "" };

function clock(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0)), h = Math.floor(v / 3600), m = Math.floor(v / 60) % 60, s = v % 60;
  return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function onStudio(tab) {
  return !!tab && typeof tab.url === "string" && tab.url.startsWith(STUDIO);
}

function capturable(tab) {
  if (!tab || tab.id === undefined) return false;
  if (typeof tab.url !== "string" || !tab.url) return true;
  return /^(https?|file):/.test(tab.url) && !onStudio(tab) && !/^https:\/\/chromewebstore\.google\.com\//.test(tab.url);
}

function ask(m) {
  return chrome.runtime.sendMessage(m).catch(e => ({ error: String((e && e.message) || e) }));
}

function errText(e) {
  if (e === "self") return M("errSelf");
  if (e === "busy") return M("errBusy");
  if (e === "closed") return M("stClosed");
  return e ? String(e) : "";
}

function renderKeys(keys) {
  const box = $("keys");
  box.textContent = "";
  for (const [name, label] of [["rec-tab", "keyTab"], ["rec-toggle", "keyToggle"], ["rec-marker", "keyMarker"]]) {
    const k = document.createElement("kbd");
    k.textContent = keys[name] || M("keysNone");
    if (!keys[name]) k.className = "off";
    const d = document.createElement("span");
    d.textContent = M(label);
    box.append(k, d);
  }
}

function render() {
  const s = P.state || {}, st = s.studio, rs = st && st.st, busy = !!rs && (rs.phase === "rec" || rs.phase === "wait");
  const self = onStudio(P.tab);
  $("dot").className = "dot" + (busy ? (rs.phase === "rec" ? " rec" : " wait") : st && st.ready ? " on" : "");
  $("stText").textContent = !st ? M("stClosed") : busy ? (rs.phase === "rec" ? M("stRec", [clock(rs.secs)]) : M("stWait")) : st.ready ? M("stReady") : M("stLogin");
  $("stName").textContent = busy ? rs.name : "";
  $("tabBtn").classList.toggle("hidden", busy || self);
  $("tabBtn").disabled = !capturable(P.tab);
  $("busyBtns").classList.toggle("hidden", !busy);
  $("markBtn").disabled = !busy || rs.phase !== "rec";
  $("openBtn").textContent = st ? M("btnShow") : M("btnOpen");
  $("openBtn").classList.toggle("hidden", self && !!st);
  const studioErr = !busy && rs && rs.err ? rs.err : "";
  $("note").textContent = P.err || studioErr || (!busy && !self && !capturable(P.tab) ? M("noCapture") : !busy && !self ? M("tabHint") : "");
  $("note").classList.toggle("info", !P.err && !studioErr);
  renderKeys(s.keys || {});
}

async function refresh() {
  P.state = await ask({ t: "state" });
  render();
}

async function init() {
  for (const el of document.querySelectorAll("[data-m]")) el.textContent = M(el.dataset.m);
  document.documentElement.lang = chrome.i18n.getUILanguage();
  try { [P.tab] = await chrome.tabs.query({ active: true, currentWindow: true }); } catch { P.tab = null; }
  $("tabBtn").addEventListener("click", async () => {
    P.err = "";
    $("tabBtn").disabled = true;
    const r = await ask({ t: "recTab", tabId: P.tab.id, title: P.tab.title || "" });
    P.err = r && r.error ? errText(r.error) : "";
    if (r && r.opened) { window.close(); return; }
    refresh();
  });
  $("stopBtn").addEventListener("click", async () => { const r = await ask({ t: "cmd", cmd: "toggle" }); P.err = r && r.error ? errText(r.error) : ""; refresh(); });
  $("markBtn").addEventListener("click", async () => { await ask({ t: "cmd", cmd: "marker" }); refresh(); });
  $("openBtn").addEventListener("click", async () => { await ask({ t: "open" }); window.close(); });
  $("keysLink").addEventListener("click", e => { e.preventDefault(); chrome.tabs.create({ url: "chrome://extensions/shortcuts" }); window.close(); });
  chrome.storage.session.onChanged.addListener(() => refresh());
  await refresh();
}

init();

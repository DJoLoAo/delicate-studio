const loginEl = document.getElementById("login");
const appEl = document.getElementById("app");
const setEl = document.getElementById("settings");
const studio = { me: null, version: null, verDismissed: false };

function esc(s) { return String(s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]); }

async function fetchMe() {
  try { return await fetch("/studio/api/me", { cache: "no-store" }); } catch { return null; }
}

function showLogin(message) {
  appEl.classList.add("hidden");
  setEl.classList.add("hidden");
  loginEl.classList.remove("hidden");
  const f = loginEl.querySelector("form");
  f.querySelector(".err").textContent = message || "";
  setTimeout(() => (f.username.value ? f.password : f.username).focus(), 30);
}

function start(me) {
  studio.me = me;
  loginEl.classList.add("hidden");
  appEl.classList.remove("hidden");
  document.getElementById("whoami").textContent = me.username + " · " + me.plan;
  document.getElementById("acctName").textContent = me.username + " · " + me.plan;
  editorStart();
}

function twoFactorStep(ticket, username) {
  const form = loginEl.querySelector("form");
  const err = form.querySelector(".err");
  const step = document.createElement("div");
  step.className = "tfstep";
  step.innerHTML = `<div class="lbl">${esc(t("Two-factor code for"))} <b>${esc(username)}</b></div><input name="tfcode" class="tfcode" inputmode="numeric" autocomplete="one-time-code" maxlength="12" placeholder="000 000"><label class="tftrust"><input type="checkbox" name="trust"><span>${esc(t("trust this browser for 30 days"))}</span></label><button type="button" class="tfgo">${esc(t("Continue"))}</button><button type="button" class="tfback">${esc(t("back"))}</button>`;
  [...form.children].forEach(ch => { if (!ch.classList.contains("logo") && ch.id !== "langLogin" && !ch.classList.contains("err")) ch.classList.add("tfhide"); });
  form.insertBefore(step, err);
  err.textContent = "";
  const inp = step.querySelector(".tfcode");
  setTimeout(() => inp.focus(), 50);
  const leave = () => { step.remove(); form.querySelectorAll(".tfhide").forEach(ch => ch.classList.remove("tfhide")); };
  const go = async () => {
    const code = inp.value.trim();
    if (!code) return false;
    let r = null;
    try { r = await fetch("/api/login/2fa", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ticket, code, trust: step.querySelector("[name=trust]").checked }) }); } catch {}
    if (r && r.ok) { leave(); return true; }
    if (r && r.status === 410) { leave(); err.textContent = t("Took too long — log in again."); return null; }
    err.textContent = t("Wrong code");
    inp.select();
    return false;
  };
  return new Promise(resolve => {
    const attempt = async () => { const ok = await go(); if (ok === true) resolve(true); else if (ok === null) resolve(false); };
    step.querySelector(".tfgo").addEventListener("click", attempt);
    inp.addEventListener("keydown", e => { if (e.key === "Enter") { e.preventDefault(); attempt(); } });
    step.querySelector(".tfback").addEventListener("click", () => { leave(); resolve(false); });
  });
}

loginEl.querySelector("form").addEventListener("submit", async e => {
  e.preventDefault();
  const f = e.target, err = f.querySelector(".err");
  err.textContent = "";
  let r = null;
  try { r = await fetch("/api/login", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ username: f.username.value, password: f.password.value }) }); } catch {}
  if (!r || !r.ok) { err.textContent = t(r && r.status === 403 ? "This account is disabled." : "Login failed"); return; }
  const j = await r.json().catch(() => ({}));
  if (j.needs2fa && !(await twoFactorStep(j.ticket, j.username || f.username.value))) return;
  const me = await fetchMe();
  if (me && me.ok) { f.password.value = ""; start(await me.json()); return; }
  err.textContent = t(me && me.status === 403 ? "This account is disabled." : "Login failed");
});

loginEl.querySelector(".eye").addEventListener("click", e => {
  const b = e.currentTarget, i = loginEl.querySelector("[name=password]");
  const show = i.type === "password";
  i.type = show ? "text" : "password";
  b.classList.toggle("on", show);
  b.setAttribute("aria-label", show ? t("Hide password") : t("Show password"));
});

function openSettings() { setEl.classList.remove("hidden"); document.getElementById("setClose").focus(); }
function closeSettings() { setEl.classList.add("hidden"); }

document.getElementById("setbtn").addEventListener("click", openSettings);
document.getElementById("setClose").addEventListener("click", closeSettings);
setEl.addEventListener("pointerdown", e => { if (e.target === setEl) closeSettings(); });
document.addEventListener("keydown", e => { if (e.key === "Escape" && !setEl.classList.contains("hidden") && !e.target.closest(".lp")) closeSettings(); });

document.getElementById("logoutbtn").addEventListener("click", async () => {
  if (!(await ask(t("Log out?"), t("This also logs you out of Delicate DJ in this browser."), { ok: t("log out") }))) return;
  try { await fetch("/api/logout", { method: "POST" }); } catch {}
  studio.me = null;
  if (ed.doc) closeDoc();
  showLogin("");
});

async function checkVersion() {
  try {
    const r = await fetch("/studio/api/version", { cache: "no-store" });
    if (!r.ok) return;
    const v = (await r.json()).version;
    if (studio.version === null) { studio.version = v; document.getElementById("stVer").textContent = "v" + v; return; }
    if (v !== studio.version && !studio.verDismissed) document.getElementById("newver").classList.remove("hidden");
  } catch {}
}

document.getElementById("newverBtn").addEventListener("click", () => location.reload());
document.getElementById("newverX").addEventListener("click", () => { studio.verDismissed = true; document.getElementById("newver").classList.add("hidden"); });

function netState() {
  const el = document.getElementById("stNet");
  el.textContent = navigator.onLine ? t("ready") : t("offline");
  el.classList.toggle("off", !navigator.onLine);
}
window.addEventListener("online", netState);
window.addEventListener("offline", netState);

async function boot() {
  if ("serviceWorker" in navigator) navigator.serviceWorker.register("/studio/sw.js", { scope: "/studio/" }).catch(() => {});
  await i18nInit();
  netState();
  const r = await fetchMe();
  if (r && r.ok) start(await r.json());
  else showLogin(r && r.status === 403 ? t("This account is disabled.") : "");
  checkVersion();
  setInterval(checkVersion, 60000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) checkVersion(); });
}

boot();

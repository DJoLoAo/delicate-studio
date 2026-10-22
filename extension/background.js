const STUDIO = "https://studio.delicateaudio.com/";
const ORIGIN = "https://studio.delicateaudio.com";
const PEND_MS = 120000;
let chain = Promise.resolve();

function locked(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

async function getState() {
  const v = await chrome.storage.session.get(["tabs", "target"]);
  return { tabs: v.tabs || {}, target: v.target || null };
}

async function putState(s) {
  await chrome.storage.session.set({ tabs: s.tabs, target: s.target });
}

function busy(st) {
  return !!st && (st.phase === "rec" || st.phase === "wait");
}

function clock(n) {
  const v = Math.max(0, Math.floor(Number(n) || 0)), h = Math.floor(v / 3600), m = Math.floor(v / 60) % 60, s = v % 60;
  return h + ":" + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
}

function clean(st) {
  const o = st && typeof st === "object" ? st : {};
  const str = (v, n) => String(v == null ? "" : v).slice(0, n);
  return { phase: str(o.phase, 12), secs: Math.max(0, Number(o.secs) || 0), marks: Math.max(0, Number(o.marks) | 0), name: str(o.name, 200), kind: str(o.kind, 12), err: str(o.err, 300) };
}

async function alive(id) {
  try { return (await chrome.tabs.sendMessage(Number(id), { t: "alive" })) === true; } catch { return false; }
}

async function studio(s) {
  let best = null, dirty = false;
  for (const id of Object.keys(s.tabs)) {
    if (!(await alive(id))) { delete s.tabs[id]; dirty = true; continue; }
    const e = s.tabs[id], score = (busy(e.st) ? 2 : 0) + (e.ready ? 1 : 0);
    if (!best || score > best.score || (score === best.score && e.seen > best.e.seen)) best = { id: Number(id), e, score };
  }
  if (dirty) { await putState(s); await badge(s); }
  return best;
}

async function badge(s) {
  const e = Object.values(s.tabs).find(x => busy(x.st)), st = e ? e.st : null;
  await chrome.action.setBadgeText({ text: st ? (st.phase === "rec" ? "REC" : "…") : "" });
  if (st) {
    await chrome.action.setBadgeBackgroundColor({ color: st.phase === "rec" ? "#c8303a" : "#6b5a3a" });
    await chrome.action.setBadgeTextColor({ color: "#ffffff" });
  }
  const title = !st ? chrome.i18n.getMessage("extName") : st.phase === "rec" ? chrome.i18n.getMessage("titleRec", [clock(st.secs), st.name]) : chrome.i18n.getMessage("titleWait");
  await chrome.action.setTitle({ title });
}

async function keys() {
  const out = {};
  for (const c of await chrome.commands.getAll()) if (c.name && c.shortcut) out[c.name] = c.shortcut;
  return out;
}

async function toPage(id, m) {
  try { await chrome.tabs.sendMessage(id, { t: "toPage", m }); return true; } catch { return false; }
}

async function focus(id, win) {
  try {
    const tab = await chrome.tabs.update(id, { active: true });
    await chrome.windows.update(win !== undefined ? win : tab.windowId, { focused: true });
  } catch {}
}

async function streamId(s, consumer) {
  const tg = s.target;
  if (!tg) return { error: "none" };
  try { await chrome.tabs.get(tg.tabId); } catch { s.target = null; return { error: "gone" }; }
  try { return { id: await chrome.tabCapture.getMediaStreamId({ targetTabId: tg.tabId, consumerTabId: consumer }) }; }
  catch (e) { return { error: String((e && e.message) || e) }; }
}

function pending(s, tabId) {
  const tg = s.target;
  return !!tg && !tg.sent && Date.now() - tg.at < PEND_MS && tg.tabId !== tabId;
}

async function here(tab) {
  const s = await getState();
  s.tabs[String(tab.id)] = { seen: Date.now(), win: tab.windowId, ready: false, st: null };
  await putState(s);
  await badge(s);
  return { ok: true };
}

async function fromPage(m, tab) {
  const s = await getState(), id = String(tab.id);
  const e = s.tabs[id] || { seen: 0, ready: false, st: null };
  Object.assign(e, { seen: Date.now(), win: tab.windowId, ready: true });
  s.tabs[id] = e;
  let out = { ok: true }, deliver = null;
  if (m.t === "ping") {
    out = { v: chrome.runtime.getManifest().version, keys: await keys() };
    if (pending(s, tab.id)) { s.target.sent = true; deliver = { t: "tab", title: s.target.title, start: true }; }
  } else if (m.t === "status") e.st = clean(m.st);
  else if (m.t === "stream") out = await streamId(s, tab.id);
  else if (m.t === "focus") await focus(tab.id, tab.windowId);
  else if (m.t === "keys") out = { keys: await keys() };
  await putState(s);
  if (m.t === "status" || m.t === "ping") await badge(s);
  if (deliver) setTimeout(() => { toPage(tab.id, deliver); }, 50);
  return out;
}

async function openStudio(s, q) {
  const st = await studio(s);
  if (st) { await focus(st.id, st.e.win); return { ok: true }; }
  await chrome.tabs.create({ url: STUDIO + (q || "") });
  return { ok: true, opened: true };
}

async function recTab(s, tabId, title) {
  const st = await studio(s);
  if (st && st.id === tabId) return { error: "self" };
  if (st && busy(st.e.st)) return { error: "busy" };
  s.target = { tabId, title: String(title || "").slice(0, 200), at: Date.now(), sent: false };
  if (st && st.e.ready) {
    s.target.sent = true;
    await putState(s);
    await toPage(st.id, { t: "tab", title: s.target.title, start: true });
    return { ok: true };
  }
  await putState(s);
  if (st) await focus(st.id, st.e.win);
  else await chrome.tabs.create({ url: STUDIO });
  return { ok: true, opened: true };
}

async function fromPopup(m) {
  const s = await getState();
  if (m.t === "state") {
    const st = await studio(s);
    return { studio: st ? { id: st.id, ready: st.e.ready, st: st.e.st } : null, keys: await keys() };
  }
  if (m.t === "open") return openStudio(s);
  if (m.t === "recTab") return recTab(s, Number(m.tabId), m.title);
  if (m.t === "cmd") {
    const st = await studio(s);
    if (!st) return { error: "closed" };
    await toPage(st.id, { t: "cmd", cmd: String(m.cmd) });
    return { ok: true };
  }
  return { error: "unknown" };
}

async function onCommand(cmd, tab) {
  const s = await getState(), st = await studio(s);
  if (cmd === "rec-tab") {
    if (st && (busy(st.e.st) || (tab && tab.id === st.id))) { await toPage(st.id, { t: "cmd", cmd: "toggle" }); return; }
    if (tab && tab.id !== undefined) await recTab(s, tab.id, tab.title);
    return;
  }
  if (!st) { if (cmd === "rec-toggle") await chrome.tabs.create({ url: STUDIO + "?rec=1" }); return; }
  await toPage(st.id, { t: "cmd", cmd: cmd === "rec-toggle" ? "toggle" : "marker" });
}

chrome.runtime.onMessage.addListener((m, sender, reply) => {
  if (!m || typeof m.t !== "string") return false;
  const own = typeof sender.url === "string" && sender.url.startsWith(chrome.runtime.getURL(""));
  let job = null;
  if (own) job = () => fromPopup(m);
  else if (sender.tab && sender.origin === ORIGIN) {
    if (m.t === "here") job = () => here(sender.tab);
    else if (m.t === "page" && m.m && typeof m.m.t === "string") job = () => fromPage(m.m, sender.tab);
  }
  if (!job) return false;
  locked(job).then(r => reply(r || { ok: true }), e => reply({ error: String((e && e.message) || e) }));
  return true;
});

chrome.commands.onCommand.addListener((cmd, tab) => { locked(() => onCommand(cmd, tab)).catch(() => {}); });

chrome.tabs.onRemoved.addListener(id => {
  locked(async () => {
    const s = await getState();
    let ch = false;
    if (s.tabs[String(id)]) { delete s.tabs[String(id)]; ch = true; }
    if (s.target && s.target.tabId === id) { s.target = null; ch = true; }
    if (ch) { await putState(s); await badge(s); }
  }).catch(() => {});
});

chrome.runtime.onInstalled.addListener(d => {
  if (d.reason === "install") chrome.tabs.create({ url: STUDIO + "?welcome=ext" });
});

const BR_URL = "ws://127.0.0.1:47391";
const BR_KEY = "studio.bridge.token";
const br = { ws: null, state: "off", seq: 0, wait: new Map(), onbin: null, ver: "", job: 0, connecting: null };

function brToken() { try { return localStorage.getItem(BR_KEY) || ""; } catch { return ""; } }
function brKeep(t) { try { localStorage.setItem(BR_KEY, t); } catch {} }

function brSet(s) {
  br.state = s;
  if (typeof ciRender === "function" && !$("cdi").classList.contains("hidden")) ciRender();
}

function brConnect() {
  if (br.ws && br.ws.readyState === 1 && br.state !== "off") return Promise.resolve(br.state);
  if (br.connecting) return br.connecting;
  br.connecting = new Promise(res => {
    let ws;
    try { ws = new WebSocket(BR_URL); } catch { br.connecting = null; brSet("off"); res("off"); return; }
    ws.binaryType = "arraybuffer";
    const done = s => { br.connecting = null; brSet(s); res(s); };
    const to = setTimeout(() => { try { ws.close(); } catch {} done("off"); }, 4000);
    ws.onopen = async () => {
      clearTimeout(to);
      br.ws = ws;
      const r = await brCall("hello", { token: brToken() }, 8000).catch(() => null);
      if (r && r.ok) { br.ver = r.version || ""; done("on"); } else done(r && r.error === "pair" ? "pair" : "off");
    };
    ws.onmessage = e => {
      if (typeof e.data !== "string") { if (br.onbin) br.onbin(e.data); return; }
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      const w = br.wait.get(m.id);
      if (w) { br.wait.delete(m.id); clearTimeout(w.to); w.res(m); }
    };
    ws.onclose = () => {
      clearTimeout(to);
      if (br.ws === ws) br.ws = null;
      for (const w of br.wait.values()) { clearTimeout(w.to); w.rej(new Error("bridge")); }
      br.wait.clear();
      if (br.connecting) done("off"); else brSet("off");
    };
  });
  return br.connecting;
}

function brCall(op, args, ms) {
  return new Promise((res, rej) => {
    if (!br.ws || br.ws.readyState !== 1) { rej(new Error("bridge")); return; }
    const id = ++br.seq, w = { res, rej, to: 0 };
    if (ms) w.to = setTimeout(() => { br.wait.delete(id); rej(new Error("timeout")); }, ms);
    br.wait.set(id, w);
    br.ws.send(JSON.stringify(Object.assign({ id, op }, args || {})));
  });
}

async function brPair() {
  if ((await brConnect()) === "off") return false;
  const r = await brCall("pair", {}, 8000).catch(() => null);
  if (!r || !r.ok) return false;
  const code = await askText(t("Pair with the Delicate Bridge"), "", { message: t("Type the six digits the Delicate Bridge shows in its window."), ok: t("Pair") });
  if (!code) return false;
  const p = await brCall("pair", { code: String(code).replace(/\D/g, "") }, 8000).catch(() => null);
  if (p && p.token) { brKeep(p.token); br.ver = p.version || ""; brSet("on"); return true; }
  tell(p && p.error === "expired" ? t("The code has expired. Ask for a new one.") : t("That code does not match."), t("Could not pair"));
  return false;
}

function brAbort() {
  if (br.job && br.ws) brCall("cancel", { job: br.job }, 4000).catch(() => {});
}

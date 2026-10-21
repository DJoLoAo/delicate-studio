const dlg = { el: null, resolve: null };

function dlgBuild() {
  if (dlg.el) return;
  const el = document.createElement("div");
  el.id = "dlg";
  el.className = "hidden";
  el.innerHTML = `<div class="dpanel" role="dialog"><div class="dtitle"></div><div class="dmsg"></div><input class="dinput" autocomplete="off" spellcheck="false"><div class="dform"></div><div class="dbtns"><button class="outbtn dcancel">cancel</button><button class="outbtn dok">ok</button></div></div>`;
  document.body.appendChild(el);
  dlg.el = el;
  el.querySelector(".dcancel").addEventListener("click", () => dlgClose(null));
  el.querySelector(".dok").addEventListener("click", () => dlgClose(dlgValue()));
  el.addEventListener("pointerdown", e => { if (e.target === el) dlgClose(null); });
  el.querySelector(".dinput").addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Enter") dlgClose(dlgValue()); if (e.key === "Escape") dlgClose(null); });
  el.addEventListener("keydown", e => { e.stopPropagation(); if (e.key === "Escape") dlgClose(null); if (e.key === "Enter" && dlg.mode !== "text") dlgClose(dlgValue()); });
}

function dlgValue() {
  if (dlg.mode === "text") return dlg.el.querySelector(".dinput").value;
  if (dlg.mode === "form") { const out = {}; dlg.el.querySelectorAll(".dform [name]").forEach(i => { out[i.name] = i.type === "checkbox" ? i.checked : i.value; }); if (dlg.read) Object.assign(out, dlg.read()); return out; }
  return true;
}

function dlgClose(v) {
  if (!dlg.resolve) return;
  dlg.el.classList.add("hidden");
  const r = dlg.resolve;
  dlg.resolve = null;
  r(v);
}

function dlgOpen(mode, title, message, value, opts) {
  dlgBuild();
  if (dlg.resolve) dlgClose(null);
  dlg.mode = mode;
  const el = dlg.el;
  el.querySelector(".dtitle").textContent = title || "";
  el.querySelector(".dmsg").textContent = message || "";
  el.querySelector(".dmsg").style.display = message ? "" : "none";
  const inp = el.querySelector(".dinput");
  inp.style.display = mode === "text" ? "" : "none";
  const form = el.querySelector(".dform");
  form.style.display = mode === "form" ? "" : "none";
  form.innerHTML = mode === "form" ? (opts && opts.html) || "" : "";
  dlg.read = mode === "form" && opts && opts.read || null;
  if (mode === "form" && opts && opts.setup) opts.setup(form);
  inp.value = value || "";
  inp.placeholder = (opts && opts.placeholder) || "";
  inp.inputMode = (opts && opts.inputmode) || "text";
  el.querySelector(".dcancel").style.display = mode === "tell" ? "none" : "";
  el.querySelector(".dok").textContent = (opts && opts.ok) || "ok";
  el.classList.remove("hidden");
  return new Promise(r => {
    dlg.resolve = r;
    requestAnimationFrame(() => { if (mode === "text") { inp.focus(); inp.select(); } else if (mode === "form") { const f = el.querySelector(".dform input, .dform .dd .cur"); if (f) f.focus(); } else el.querySelector(".dok").focus(); });
  });
}

function askText(title, value, opts) { return dlgOpen("text", title, opts && opts.message, value, opts); }
function askForm(title, html, opts) { return dlgOpen("form", title, opts && opts.message, "", Object.assign({ html }, opts || {})); }
function ask(title, message, opts) { return dlgOpen("confirm", title, message, "", opts).then(v => v === true); }
function tell(message, title) { return dlgOpen("tell", title || "", message, "", {}).then(() => undefined); }

function winDrag(el, key, opts) {
  const head = el.querySelector(".qhead");
  const o = Object.assign({ ignore: "button, .dd, input, select, textarea", mobile: "(max-width:760px)", onReset: null }, opts || {});
  const place = (x, y, save) => {
    const w = el.offsetWidth || 400, h = Math.min(el.offsetHeight || 200, 120);
    x = Math.max(0, Math.min(window.innerWidth - Math.min(w, window.innerWidth), x));
    y = Math.max(0, Math.min(window.innerHeight - h, y));
    el.style.left = x + "px"; el.style.top = y + "px"; el.style.right = "auto"; el.style.bottom = "auto";
    if (save) localStorage.setItem(key, JSON.stringify({ x, y }));
  };
  const reset = () => { el.style.left = el.style.top = el.style.right = el.style.bottom = ""; localStorage.removeItem(key); if (o.onReset) o.onReset(); };
  const restore = () => {
    if (window.matchMedia(o.mobile).matches) { el.style.left = el.style.top = el.style.right = el.style.bottom = ""; return; }
    let saved = null;
    try { saved = JSON.parse(localStorage.getItem(key) || "null"); } catch {}
    if (!saved || !Number.isFinite(saved.x) || !Number.isFinite(saved.y)) { localStorage.removeItem(key); return; }
    if (!el.offsetWidth) return;
    if (saved.x < 0 || saved.y < 0 || saved.x + 140 > window.innerWidth || saved.y + 40 > window.innerHeight) { reset(); return; }
    place(saved.x, saved.y, false);
  };
  restore();
  if (window.ResizeObserver) new ResizeObserver(() => { if (el.offsetWidth) restore(); }).observe(el);
  window.addEventListener("resize", restore);
  head.addEventListener("pointerdown", e => {
    if (e.target.closest(o.ignore) || window.matchMedia(o.mobile).matches) return;
    e.preventDefault();
    const r = el.getBoundingClientRect(), dx = e.clientX - r.left, dy = e.clientY - r.top;
    head.setPointerCapture(e.pointerId);
    const move = ev => place(ev.clientX - dx, ev.clientY - dy, false);
    const up = () => { head.removeEventListener("pointermove", move); head.removeEventListener("pointerup", up); const rr = el.getBoundingClientRect(); place(rr.left, rr.top, true); };
    head.addEventListener("pointermove", move); head.addEventListener("pointerup", up);
  });
  head.addEventListener("dblclick", e => { if (e.target.closest(o.ignore)) return; reset(); });
  head.title = "drag to move · double-click to put it back";
  return { reset, restore };
}

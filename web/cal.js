const cal = { el: null, view: null, val: "", pick: null, anchor: null };

function calIso(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

function calParse(v) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(v || ""));
  if (!m) return null;
  const d = new Date(+m[1], +m[2] - 1, +m[3]);
  return d.getMonth() === +m[2] - 1 ? d : null;
}

function calFmt(v) {
  const d = calParse(v);
  return d ? d.toLocaleDateString((typeof i18n !== "undefined" && i18n.lang) || undefined, { year: "numeric", month: "long", day: "numeric" }) : "";
}

function calClose() {
  if (cal.el) cal.el.remove();
  cal.el = null;
  cal.pick = null;
  cal.anchor = null;
  document.removeEventListener("pointerdown", calOutside, true);
  document.removeEventListener("keydown", calKey, true);
}

function calOutside(e) { if (cal.el && !cal.el.contains(e.target) && e.target !== cal.anchor) calClose(); }

function calKey(e) { if (e.key === "Escape") { e.stopPropagation(); e.preventDefault(); calClose(); } }

function calOpen(anchor, value, onPick) {
  if (cal.el && cal.anchor === anchor) { calClose(); return; }
  calClose();
  const d = calParse(value) || new Date();
  cal.view = new Date(d.getFullYear(), d.getMonth(), 1);
  cal.val = calParse(value) ? value : "";
  cal.pick = onPick;
  cal.anchor = anchor;
  cal.el = document.createElement("div");
  cal.el.className = "cal";
  document.body.appendChild(cal.el);
  calDraw();
  const r = anchor.getBoundingClientRect(), w = cal.el.offsetWidth, h = cal.el.offsetHeight;
  cal.el.style.left = Math.max(8, Math.min(window.innerWidth - w - 8, r.left)) + "px";
  cal.el.style.top = (r.bottom + h + 8 > window.innerHeight && r.top - h - 4 > 0 ? r.top - h - 4 : r.bottom + 4) + "px";
  document.addEventListener("pointerdown", calOutside, true);
  document.addEventListener("keydown", calKey, true);
}

function calDraw() {
  const el = cal.el, v = cal.view, lang = (typeof i18n !== "undefined" && i18n.lang) || undefined, today = calIso(new Date());
  el.textContent = "";
  const head = document.createElement("div");
  head.className = "calhead";
  const nav = (txt, dm, label) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "calnav";
    b.textContent = txt;
    b.setAttribute("aria-label", label);
    b.addEventListener("click", () => { cal.view = new Date(v.getFullYear(), v.getMonth() + dm, 1); calDraw(); });
    return b;
  };
  const title = document.createElement("span");
  title.className = "caltitle";
  title.textContent = v.toLocaleDateString(lang, { month: "long", year: "numeric" });
  head.append(nav("«", -12, t("Previous year")), nav("‹", -1, t("Previous month")), title, nav("›", 1, t("Next month")), nav("»", 12, t("Next year")));
  el.appendChild(head);
  const grid = document.createElement("div");
  grid.className = "calgrid";
  const mon = new Date(2024, 0, 1);
  for (let i = 0; i < 7; i++) {
    const s = document.createElement("span");
    s.className = "calwd";
    s.textContent = new Date(mon.getFullYear(), 0, 1 + i).toLocaleDateString(lang, { weekday: "narrow" });
    grid.appendChild(s);
  }
  const lead = (v.getDay() + 6) % 7, days = new Date(v.getFullYear(), v.getMonth() + 1, 0).getDate();
  for (let i = 0; i < lead; i++) grid.appendChild(document.createElement("span"));
  for (let n = 1; n <= days; n++) {
    const iso = calIso(new Date(v.getFullYear(), v.getMonth(), n)), b = document.createElement("button");
    b.type = "button";
    b.className = "calday" + (iso === cal.val ? " on" : "") + (iso === today ? " today" : "");
    b.textContent = String(n);
    b.dataset.d = iso;
    b.addEventListener("click", () => { const f = cal.pick; calClose(); if (f) f(iso); });
    grid.appendChild(b);
  }
  el.appendChild(grid);
  const foot = document.createElement("div");
  foot.className = "calfoot";
  const tb = document.createElement("button");
  tb.type = "button";
  tb.className = "outbtn";
  tb.textContent = t("Today");
  tb.addEventListener("click", () => { const f = cal.pick; calClose(); if (f) f(today); });
  foot.appendChild(tb);
  if (cal.val) {
    const cb = document.createElement("button");
    cb.type = "button";
    cb.className = "outbtn";
    cb.textContent = t("Clear");
    cb.addEventListener("click", () => { const f = cal.pick; calClose(); if (f) f(""); });
    foot.appendChild(cb);
  }
  el.appendChild(foot);
}

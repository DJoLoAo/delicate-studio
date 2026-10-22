const THEME_BASE = {
  vars: { bg: "#0c0a08", bg2: "#12100e", bg3: "#1a1710", bg4: "#231f18", border: "#2a2520", pink: "#DF39BB", blue: "#5AC1F9", gold: "#DF9A24", green: "#4caf50", red: "#9B151B", white: "#e0e0e0", gray: "#888888", dim: "#555555", font: "'JetBrains Mono',monospace", mono: "'JetBrains Mono',monospace", serif: "'Instrument Serif',serif" },
  cv: { dark: "#0c0a08", canvas: "#0e0c0a", graph: "#0d0c0b", spec: "#0c0a09", laneA: "#110f0c", laneB: "#13110e", panel: "#12100e", ink: "#f2efe9", text: "#c9c3b9", muted: "#a39d93", label: "#7d776e", label2: "#6f695f", glabel: "#6f6a62", faint: "#5f5a52", tick: "#3a352f", line: "#2a2520", meterBg: "#1a1710", meterOff: "#231f18", shade: "#0a0908", shade2: "#0c0a09", pink: "#DF39BB", gold: "#DF9A24", blue: "#5AC1F9", peak: "#ff3b30", gblue: "#5b8def", ggold: "#c9a96e", gred: "#e5484d", ggreen: "#6cc480", rred: "#ff6b6f", grey: "#8c8c8c", ice: "#8cd6ff", warm: "#e0a090", white: "#ffffff", hiK: 1 },
};

const THEMES = {
  delicate: { name: "Delicate", fs: 1, vars: {}, cv: {} },
  large: {
    name: "Large print",
    fs: 1.3,
    vars: { bg2: "#14120f", bg3: "#1f1b15", bg4: "#2b261e", border: "#4d453a", white: "#f4f1ea", gray: "#bdb6ab", dim: "#8f887c" },
    cv: { text: "#e8e3da", muted: "#cbc5bb", label: "#b3ac9f", label2: "#a69f92", glabel: "#a69f92", faint: "#8f887c", tick: "#5c544a", line: "#4d453a", hiK: 1.7 },
  },
  phimonic: {
    name: "Phimonic",
    fs: 1,
    quiet: true,
    vars: { font: "'Phimonic','JetBrains Mono',monospace", serif: "'Phimonic Straightened','Instrument Serif',serif" },
    cv: {},
  },
};

const TEXT_LABELS = { theme: "Theme default", "1": "Normal · 100%", "1.15": "Large · 115%", "1.3": "Larger · 130%", "1.5": "Largest · 150%" };

const TEXT_SIZES = ["theme", "1", "1.15", "1.3", "1.5"];
const TH = { rgb: {} };
const THS = { id: "delicate", size: "theme", rev: 0 };

function thHex(h) { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }

function thTheme(id) { return THEMES[id] || THEMES.delicate; }

function thFs() { return THS.size === "theme" ? (thTheme(THS.id).fs || 1) : +THS.size; }

function tc(k, a) {
  if (a === undefined) return TH[k];
  const c = TH.rgb[k];
  return "rgba(" + c[0] + "," + c[1] + "," + c[2] + "," + a + ")";
}

function tw(a) { return "rgba(255,255,255," + Math.min(1, +(a * TH.hiK).toFixed(3)) + ")"; }

function thFont(px, k) { return (px * thFs() * (k || 1)) + "px " + TH.mono; }

function thQuiet(c, bg) {
  const a = thHex(c), b = thHex(bg);
  return "#" + a.map((v, i) => Math.round(v * 0.7 + b[i] * 0.3).toString(16).padStart(2, "0")).join("");
}

function thApply() {
  const t = thTheme(THS.id), vars = Object.assign({}, THEME_BASE.vars, t.vars), cv = Object.assign({}, THEME_BASE.cv, t.cv);
  const root = document.documentElement;
  for (const k of ["pink", "blue", "gold", "green", "red"]) {
    vars[k + "-full"] = vars[k];
    if (t.quiet) vars[k] = thQuiet(vars[k], vars.bg);
  }
  for (const k in vars) root.style.setProperty("--" + k, vars[k]);
  root.classList.toggle("fph", /Phimonic/.test(vars.font));
  root.classList.toggle("tquiet", !!t.quiet);
  root.style.setProperty("--fs", String(thFs()));
  root.dataset.theme = THS.id;
  THS.rev++;
  for (const k in TH) if (k !== "rgb") delete TH[k];
  Object.assign(TH, cv);
  TH.mono = vars.mono.replace(/'/g, "");
  TH.rgb = {};
  for (const k in cv) if (typeof cv[k] === "string" && cv[k][0] === "#") TH.rgb[k] = thHex(cv[k]);
  TH.wave = [TH.rgb.pink, TH.rgb.gold, TH.rgb.blue];
  TH.plain = "rgb(" + TH.rgb.pink.join(",") + ")";
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute("content", vars.bg);
}

function thLoad() {
  try {
    const id = localStorage.getItem("studioTheme"), sz = localStorage.getItem("studioTextSize");
    if (THEMES[id]) THS.id = id;
    if (TEXT_SIZES.includes(sz)) THS.size = sz;
  } catch {}
}

function thChanged() {
  thApply();
  thNote();
  window.dispatchEvent(new Event("themechange"));
  window.dispatchEvent(new Event("resize"));
}

function thNote() {
  const n = document.getElementById("textSizeNote");
  if (n) n.textContent = THS.size === "theme" ? Math.round(thFs() * 100) + "%" : "";
}

function thWire() {
  ddInit(document.getElementById("themeDd"), Object.keys(THEMES).map(id => ({ v: id, label: THEMES[id].name })), THS.id, setTheme);
  ddInit(document.getElementById("textSizeDd"), TEXT_SIZES.map(v => ({ v, label: TEXT_LABELS[v] })), THS.size, setTextSize);
  thNote();
}

function setTheme(id) {
  if (!THEMES[id]) return;
  THS.id = id;
  try { localStorage.setItem("studioTheme", id); } catch {}
  thChanged();
}

function setTextSize(v) {
  if (!TEXT_SIZES.includes(v)) return;
  THS.size = v;
  try { localStorage.setItem("studioTextSize", v); } catch {}
  thChanged();
}

thLoad();
thApply();

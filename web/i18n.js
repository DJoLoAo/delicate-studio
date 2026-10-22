const I18N_LANGS = { en: "English", de: "Deutsch", fr: "Français", es: "Español", it: "Italiano", pt: "Português", hi: "हिन्दी" };
const I18N_COUNTRIES = ["GB", "DE", "FR", "ES", "IT", "PT", "IN", "US", "AT", "CH", "BR", "MX"];
const i18n = { lang: "en", dict: {}, rev: {}, obs: null, pickers: [] };
const I18N_SKIP = "#recT, #recTime, #recPk, #recInfo, #recSize, #recSum, #recDev, #recCh, #recRate, #recThrV, #mdSum, #mdRangeT, #mdSensV, #mdTrack, #textSizeNote, #whoami, #acctName, #docName, #docInfo, #tnow, #tlen, #busyName, #busyPct, #stMsg, #histN, #histList, #locsList, #palList, #xPreview, .xn, #dgList, #dgSensV, #nrPrint, #nrSum, #nrRange, #nrAmtV, #nrFloorV, #nrThrV, #nrDecayV, #nrPrecV, #nrFft, #dgFx, #dgTolV, #humInfo, #humSum, #humRange, #humNV, #humQV, #humGainV, #humSlopeV, #spResDd, #spRangeDd, #spBrushV, #ldStats, #ldSum, #ldRange, #ldRefInfo, #ldCeilV, #ldRelV, #ldLookV, #ldPeakV, #ldTarget, .ldrefs, .hl, .fn, .fi, canvas, svg, script, style, .lp";

function i18nDetect() {
  const stored = localStorage.getItem("djLang");
  if (stored && I18N_LANGS[stored]) return stored;
  for (const l of navigator.languages || [navigator.language || "en"]) { const s = l.slice(0, 2).toLowerCase(); if (I18N_LANGS[s]) return s; }
  return "en";
}

function t(s) { const v = i18n.dict[s]; return v === undefined ? s : v; }

async function i18nLoad(lang) {
  if (!I18N_LANGS[lang]) lang = "en";
  let dict = {};
  if (lang !== "en") {
    try { const r = await fetch("/i18n/" + lang + ".json"); if (r.ok) dict = await r.json(); } catch {}
  }
  i18n.lang = lang;
  i18n.dict = dict;
  i18n.rev = {};
  for (const k in dict) if (dict[k]) i18n.rev[dict[k]] = k;
  document.documentElement.lang = lang;
  localStorage.setItem("djLang", lang);
  i18nWalk(document.body);
  const country = { en: "GB", de: "DE", fr: "FR", es: "ES", it: "IT", pt: "PT", hi: "IN" }[lang] || "GB";
  for (const p of i18n.pickers) { try { p.setLocale(lang); p.setValue(country); p.setLabels({ featured: t("App languages"), search: t("Search country or language"), empty: t("No match"), button: t("Language"), all: t("All") }); } catch {} }
  document.dispatchEvent(new Event("i18n"));
}

function i18nText(node) {
  const raw = node.nodeValue;
  const key = node.i18nKey !== undefined ? node.i18nKey : raw.replace(/\s+/g, " ").trim();
  if (!key) return;
  if (node.i18nKey === undefined) {
    const src = i18n.rev[key] !== undefined ? i18n.rev[key] : key;
    if (i18n.dict[src] === undefined && src === key) return;
    node.i18nKey = src;
  }
  const out = t(node.i18nKey);
  const lead = raw.match(/^\s*/)[0], trail = raw.match(/\s*$/)[0];
  const next = lead + out + trail;
  if (node.nodeValue !== next) node.nodeValue = next;
}

function i18nAttr(el, name) {
  const v = el.getAttribute(name);
  if (!v) return;
  const store = "i18n" + name;
  const src = el[store] !== undefined ? el[store] : (i18n.rev[v] !== undefined ? i18n.rev[v] : v);
  if (el[store] === undefined && i18n.dict[src] === undefined) return;
  el[store] = src;
  const out = t(src);
  if (el.getAttribute(name) !== out) el.setAttribute(name, out);
}

function i18nWalk(root) {
  if (!root) return;
  if (root.nodeType === 3) { if (!(root.parentNode && root.parentNode.closest && root.parentNode.closest(I18N_SKIP))) i18nText(root); return; }
  if (root.nodeType !== 1 || root.closest(I18N_SKIP)) return;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeType === 1 ? (n.matches(I18N_SKIP) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) : NodeFilter.FILTER_ACCEPT });
  const els = [root];
  let n;
  while (n = walker.nextNode()) { if (n.nodeType === 3) i18nText(n); else els.push(n); }
  for (const el of els) { for (const a of ["title", "placeholder", "aria-label"]) if (el.hasAttribute(a)) i18nAttr(el, a); }
}

function i18nObserve() {
  if (i18n.obs) return;
  i18n.obs = new MutationObserver(muts => {
    if (i18n.lang === "en" && !Object.keys(i18n.rev).length) return;
    for (const m of muts) {
      if (m.type === "characterData") { const n = m.target; if (n.i18nKey !== undefined) { const raw = n.nodeValue.replace(/\s+/g, " ").trim(); if (raw !== t(n.i18nKey) && raw !== n.i18nKey) n.i18nKey = undefined; } i18nWalk(n); }
      else if (m.type === "attributes") { const el = m.target, a = m.attributeName, store = "i18n" + a; if (el[store] !== undefined && el.getAttribute(a) !== t(el[store])) el[store] = undefined; if (el.closest && !el.closest(I18N_SKIP)) i18nAttr(el, a); }
      else for (const n of m.addedNodes) i18nWalk(n);
    }
  });
  i18n.obs.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ["title", "placeholder", "aria-label"] });
}

async function i18nPicker(el, opts) {
  if (!el) return null;
  try {
    const mod = await import("/worldpicker/lang-picker.js");
    const countryOf = { en: "GB", de: "DE", fr: "FR", es: "ES", it: "IT", pt: "PT", hi: "IN" };
    const p = mod.createLangPicker(el, Object.assign({
      featured: I18N_COUNTRIES,
      languages: Object.keys(I18N_LANGS),
      fallbackLanguage: "en",
      value: countryOf[i18n.lang] || "GB",
      code: "language",
      locale: i18n.lang,
      labels: { featured: t("App languages"), search: t("Search country or language"), empty: t("No match"), button: t("Language"), all: t("All") },
      theme: { accent: "#DF39BB", ink: "#f2efe9", muted: "#9a948a", faint: "#5f5a52", line: "#2a2622", panel: "#15130f", land: "#1f1b17", country: "#2d2721", border: "#0b0a09", dot: "#8a6a33", hot: "#DF39BB", hotDot: "#ffd27a", tint: "#DF39BB", tintStrength: 0.35, radius: "0px", font: "inherit" },
      onChange: d => { if (d && d.language && d.language !== i18n.lang) i18nLoad(d.language); }
    }, opts || {}));
    i18n.pickers.push(p);
    return p;
  } catch (e) { return null; }
}

async function i18nInit() {
  i18n.lang = i18nDetect();
  await i18nLoad(i18n.lang);
  i18nObserve();
  i18nPicker(document.getElementById("langLogin"), { align: "start" });
  i18nPicker(document.getElementById("langSettings"), { align: "start" });
}

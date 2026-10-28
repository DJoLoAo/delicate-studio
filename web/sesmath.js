const SM_FLOOR = -60, SM_TOP = 12;

function smXfades(clips) {
  const L = clips.slice().sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)), out = new Map();
  for (const k of L) out.set(k.id, { xi: 0, xo: 0 });
  for (let i = 0; i + 1 < L.length; i++) {
    const a = L[i], b = L[i + 1], ae = a.at + a.len, be = b.at + b.len;
    if (b.at >= ae || be <= ae || b.at <= a.at) continue;
    const ov = ae - b.at;
    out.get(a.id).xo = ov;
    out.get(b.id).xi = ov;
  }
  return out;
}

function smHole(clips, a, b) {
  const out = [];
  for (const k of clips) {
    const e = k.at + k.len;
    if (e <= a || (b >= 0 && k.at >= b)) { out.push(k); continue; }
    if (k.at < a) out.push(Object.assign({}, k, { len: a - k.at, fin: Math.min(k.fin, a - k.at), fout: 0 }));
    if (b >= 0 && e > b) out.push(Object.assign({}, k, { id: k.id + "~", at: b, from: k.from + (b - k.at), len: e - b, fin: 0, fout: Math.min(k.fout, e - b) }));
  }
  return out;
}

function smXin(q, xi) { return xi > 0 && q < xi ? Math.sin((q + 0.5) / xi * Math.PI / 2) : 1; }
function smXout(q, len, xo) { const s = len - xo; return xo > 0 && q >= s ? Math.cos((q - s + 0.5) / xo * Math.PI / 2) : 1; }

function smAt(pts, f) {
  if (!pts || !pts.length) return null;
  if (f <= pts[0][0]) return pts[0][1];
  const n = pts.length;
  if (f >= pts[n - 1][0]) return pts[n - 1][1];
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const m = (lo + hi) >> 1; if (pts[m][0] <= f) lo = m; else hi = m; }
  const [f0, v0] = pts[lo], [f1, v1] = pts[hi];
  return f1 === f0 ? v1 : v0 + (v1 - v0) * (f - f0) / (f1 - f0);
}

function smBlock(pts, p, n, out) {
  for (let i = 0; i < n; i++) out[i] = smAt(pts, p + i);
}

function smGain(db) { return db <= SM_FLOOR ? 0 : Math.pow(10, db / 20); }

function smPanGains(pan, mono) {
  if (mono) { const th = (pan + 1) * Math.PI / 4; return [Math.cos(th), Math.sin(th)]; }
  return [pan > 0 ? 1 - pan : 1, pan < 0 ? 1 + pan : 1];
}

if (typeof module !== "undefined") module.exports = { SM_FLOOR, SM_TOP, smXfades, smXin, smXout, smAt, smBlock, smGain, smPanGains };

const ON_LEVELS = {
  low: { k: 0.2, rise: 3 },
  normal: { k: 0.08, rise: 2 },
  high: { k: 0.05, rise: 1.5 },
  max: { k: 0.025, rise: 1.5 }
};
const ON_FLOOR = 1e-7;
const ON_EDGE = { pre: 2.5, peak: 0.05, back: 1.5 };

function onMean(env, a, b) {
  a = Math.max(0, a);
  b = Math.min(env.length, b);
  if (b <= a) return 0;
  let s = 0;
  for (let i = a; i < b; i++) s += env[i];
  return s / (b - a);
}

function onPeaks(flux, fps, k) {
  const T = flux.length, cum = new Float64Array(T + 1);
  for (let t = 0; t < T; t++) cum[t + 1] = cum[t] + flux[t];
  const w0 = Math.max(1, Math.round(0.1 * fps)), w1 = Math.max(1, Math.round(0.07 * fps)), wm = Math.max(1, Math.round(0.03 * fps));
  const out = [];
  for (let t = 1; t < T; t++) {
    const v = flux[t];
    if (!(v > 0)) continue;
    let peak = true;
    for (let u = Math.max(0, t - wm); u < t && peak; u++) if (flux[u] >= v) peak = false;
    for (let u = t + 1; u <= Math.min(T - 1, t + wm) && peak; u++) if (flux[u] > v) peak = false;
    if (!peak) continue;
    const a = Math.max(0, t - w0), b = Math.min(T, t + w1 + 1), m = (cum[b] - cum[a]) / (b - a);
    if (v >= m + k) out.push({ t, s: v - m });
  }
  return out;
}

function onRise(e, j) {
  return 10 * Math.log10((onMean(e, j + 3, j + 23) + 1e-12) / (onMean(e, j - 25, j - 3) + 1e-12));
}

function onBlock(env, j0, j1) {
  let best = -1, br = 0;
  for (let j = Math.max(6, j0); j < Math.min(env.length - 3, j1); j++) {
    const r = (env[j] + env[j + 1] + env[j + 2]) / 3 / (onMean(env, j - 6, j) + 1e-12);
    if (r > br) { br = r; best = j; }
  }
  return best;
}

function onSample(raw, s0, blk, pre, j) {
  const x = new Float32Array(raw.length);
  for (let i = 1; i < raw.length; i++) x[i] = raw[i] - raw[i - 1];
  const from = (j - 1) * blk - s0, peakTo = Math.min(x.length, (j + 3) * blk - s0);
  let peak = 0;
  for (let i = Math.max(0, j * blk - s0); i < peakTo; i++) { const v = Math.abs(x[i]); if (v > peak) peak = v; }
  const thr = Math.max(ON_EDGE.pre * pre, ON_EDGE.peak * peak);
  let p = -1;
  for (let i = Math.max(1, from); i < peakTo; i++) if (Math.abs(x[i]) >= thr) { p = i; break; }
  if (p < 0) return j * blk;
  let q = p;
  while (q > Math.max(1, p - Math.round(ON_EDGE.back * blk)) && Math.sign(raw[q - 1]) === Math.sign(raw[q]) && raw[q] !== 0) q--;
  return s0 + q;
}

function onFind(feat, read, level) {
  const L = ON_LEVELS[level] || ON_LEVELS.normal;
  const { flux, env, envr, n, hop, blk, sr, len } = feat;
  const fps = sr / hop, minGap = Math.round(sr * 0.015);
  const pos = [], str = [];
  for (const c of onPeaks(flux, fps, L.k)) {
    const s = c.t * hop;
    const j = onBlock(env, Math.floor(s / blk), Math.ceil((s + n) / blk));
    if (j < 0) continue;
    const post = onMean(envr, j + 3, j + 23);
    if (post < ON_FLOOR) continue;
    const rise = Math.max(onRise(env, j), onRise(envr, j));
    if (rise < L.rise) continue;
    const s0 = Math.max(0, (j - 4) * blk), cnt = Math.min(len, (j + 4) * blk) - s0;
    if (cnt <= blk) continue;
    const p = onSample(read(s0, cnt), s0, blk, Math.sqrt(onMean(env, j - 8, j)), j);
    if (p < 0 || p >= len) continue;
    if (pos.length && p - pos[pos.length - 1] < minGap) {
      if (c.s > str[str.length - 1]) { pos[pos.length - 1] = p; str[str.length - 1] = c.s; }
      continue;
    }
    pos.push(p);
    str.push(c.s);
  }
  const order = pos.map((_, i) => i).sort((a, b) => pos[a] - pos[b]);
  return { pos: order.map(i => pos[i]), str: order.map(i => str[i]) };
}

if (typeof module !== "undefined") module.exports = { ON_LEVELS, ON_EDGE, onRise, onPeaks, onBlock, onSample, onFind, onMean };

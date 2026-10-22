const TR_HOP = 0.01;

function trMedian(x, w) {
  const n = x.length, h = w >> 1, out = new Float32Array(n), buf = new Float32Array(w);
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - h), b = Math.min(n, i + h + 1), m = b - a;
    for (let j = 0; j < m; j++) buf[j] = x[a + j];
    out[i] = buf.subarray(0, m).sort()[m >> 1];
  }
  return out;
}

function trSmooth(x, w) {
  const n = x.length, h = w >> 1, pre = new Float64Array(n + 1), out = new Float32Array(n);
  for (let i = 0; i < n; i++) pre[i + 1] = pre[i] + x[i];
  for (let i = 0; i < n; i++) { const a = Math.max(0, i - h), b = Math.min(n, i + h + 1); out[i] = (pre[b] - pre[a]) / (b - a); }
  return out;
}

function trPct(x, p) {
  const s = Float32Array.from(x).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))];
}

function trAnalyze(env, o) {
  const n = env.length, hop = o.hop;
  if (n < 50) return null;
  const pool = [];
  for (let i = 0; i < n; i++) if (env[i] > -100) pool.push(env[i]);
  const floor = pool.length ? trPct(pool, Math.min(0.01, Math.max(0.001, 150 / pool.length))) : -100, loud = [];
  for (let i = 0; i < n; i++) if (env[i] > floor + 12) loud.push(env[i]);
  const music = loud.length ? trPct(loud, 0.5) : floor + 20;
  const auto = Math.min(music - 12, floor + Math.max(6, Math.min(15, (music - floor) * 0.3)));
  const thr = Number.isFinite(o.thr) ? o.thr : auto;
  let start = -1, end = -1;
  for (let i = 0; i < n; i++) if (env[i] > thr) { if (start < 0) start = i; end = i; }
  const res = { n, hop, floor, music, auto, thr, start, end, gaps: [], dips: [] };
  if (start < 0) return res;
  const minRun = Math.max(1, Math.round(o.minGap / hop));
  for (let i = start; i <= end;) {
    if (env[i] >= thr) { i++; continue; }
    let j = i, mn = Infinity;
    while (j <= end && env[j] < thr) { if (env[j] < mn) mn = env[j]; j++; }
    if (j - i >= minRun) res.gaps.push({ a: i, b: j, min: mn, score: (music - mn) / 10 + Math.min((j - i) * hop, 4) / 2 });
    i = j;
  }
  const sm = trSmooth(env, Math.max(1, Math.round(0.5 / hop)));
  const sh = Math.round(4 / hop), loc = Math.round(0.25 / hop), guard = Math.round(2 / hop);
  const near = i => res.gaps.some(g => i > g.a - guard && i < g.b + guard);
  const raw = [];
  for (let i = start + guard; i <= end - guard; i++) {
    const v = sm[i];
    let ok = true;
    for (let k = Math.max(0, i - loc); k <= Math.min(n - 1, i + loc) && ok; k++) if (sm[k] < v || (sm[k] === v && k < i)) ok = false;
    if (!ok || near(i)) continue;
    let L = -Infinity, R = -Infinity;
    for (let k = Math.max(0, i - sh); k < i; k++) if (sm[k] > L) L = sm[k];
    for (let k = i + 1; k <= Math.min(n - 1, i + sh); k++) if (sm[k] > R) R = sm[k];
    const depth = Math.min(L, R) - v;
    if (depth >= 8) raw.push({ t: i, depth, score: depth / 10 - 0.3 });
  }
  raw.sort((p, q) => q.depth - p.depth);
  for (const d of raw) if (!res.dips.some(x => Math.abs(x.t - d.t) < guard)) res.dips.push(d);
  res.dips.sort((p, q) => p.t - q.t);
  return res;
}

function trSplitOf(g, lead) {
  return Math.max(g.a + ((g.b - g.a) >> 1), g.b - lead);
}

function trPlan(an, o) {
  if (!an || an.start < 0) return null;
  const hop = an.hop, lead = Math.round((o.lead || 0.4) / hop), tail = Math.round((o.tail || 1) / hop), minT = Math.round((o.minTrack || 10) / hop);
  const b0 = Math.max(0, an.start - lead), bN = Math.min(an.n, an.end + 1 + tail);
  const gapC = an.gaps.map(g => ({ t: trSplitOf(g, lead), score: g.score, kind: "gap" }));
  const N = Math.max(0, o.want | 0), durs = o.durs || [];
  if (!N) {
    const c = gapC.filter(x => x.t - b0 >= minT && bN - x.t >= minT);
    for (;;) {
      let worst = -1;
      for (let i = 0; i < c.length; i++) {
        const prev = i ? c[i - 1].t : b0, next = i + 1 < c.length ? c[i + 1].t : bN;
        if ((c[i].t - prev < minT || next - c[i].t < minT) && (worst < 0 || c[i].score < c[worst].score)) worst = i;
      }
      if (worst < 0) break;
      c.splice(worst, 1);
    }
    return { bounds: [b0].concat(c.map(x => x.t), [bN]), kinds: c.map(x => x.kind), scale: 1 };
  }
  if (N === 1) return { bounds: [b0, bN], kinds: [], scale: 1 };
  const all = durs.length >= N && durs.slice(0, N).every(d => d > 0);
  let scale = 1;
  if (all) scale = Math.max(0.92, Math.min(1.08, (bN - b0) * hop / durs.slice(0, N).reduce((p, q) => p + q, 0)));
  let cands = gapC.concat(an.dips.map(d => ({ t: d.t, score: d.score, kind: "dip" })));
  let cum = 0;
  for (let k = 0; k < N - 1 && durs[k] > 0; k++) { cum += durs[k]; cands.push({ t: Math.round(b0 + cum * scale / hop), score: -1.5, kind: "est" }); }
  cands = cands.filter(x => x.t - b0 >= minT && bN - x.t >= minT).sort((p, q) => p.t - q.t);
  const M = cands.length, K = N - 1;
  if (M < K) return null;
  const dc = (k, len) => {
    const d = durs[k];
    if (!(d > 0)) return 0;
    const L = len * hop, D = d * scale, s = Math.max(4, 0.04 * D);
    return 0.5 * Math.min(((L - D) / s) ** 2, 25);
  };
  const best = [], from = [];
  for (let k = 0; k < K; k++) { best.push(new Float64Array(M).fill(-Infinity)); from.push(new Int32Array(M).fill(-1)); }
  for (let j = 0; j < M; j++) if (cands[j].t - b0 >= minT) best[0][j] = cands[j].score - dc(0, cands[j].t - b0);
  for (let k = 1; k < K; k++) {
    for (let j = 0; j < M; j++) {
      let bv = -Infinity, bi = -1;
      for (let i = 0; i < j; i++) {
        const p = best[k - 1][i];
        if (p === -Infinity || cands[j].t - cands[i].t < minT) continue;
        const v = p + cands[j].score - dc(k, cands[j].t - cands[i].t);
        if (v > bv) { bv = v; bi = i; }
      }
      best[k][j] = bv;
      from[k][j] = bi;
    }
  }
  let bv = -Infinity, bj = -1;
  for (let j = 0; j < M; j++) {
    if (best[K - 1][j] === -Infinity || bN - cands[j].t < minT) continue;
    const v = best[K - 1][j] - dc(N - 1, bN - cands[j].t);
    if (v > bv) { bv = v; bj = j; }
  }
  if (bj < 0) return null;
  const pick = [];
  for (let k = K - 1, j = bj; k >= 0; k--) { pick.unshift(cands[j]); j = from[k][j]; }
  return { bounds: [b0].concat(pick.map(x => x.t), [bN]), kinds: pick.map(x => x.kind), scale };
}

function trDur(s) {
  const p = String(s || "").trim().split(":").map(Number);
  if (!p.length || p.some(v => !Number.isFinite(v) || v < 0)) return 0;
  return p.reduce((acc, v) => acc * 60 + v, 0);
}

function trSides(tracks) {
  const sides = [];
  for (const tr of tracks) {
    const m = /^([A-Za-z]+)/.exec(String(tr.position || "").trim()), k = m ? m[1].toUpperCase() : "";
    let s = sides.find(x => x.k === k);
    if (!s) sides.push(s = { k, tracks: [] });
    s.tracks.push(tr);
  }
  return sides;
}

function trGuess(opts, span) {
  let best = 0, bd = Infinity;
  opts.forEach((o, i) => {
    const d = o.tracks.map(x => trDur(x.duration));
    if (!d.length || d.some(v => !(v > 0))) return;
    const diff = Math.abs(d.reduce((p, q) => p + q, 0) - span);
    if (diff < bd) { bd = diff; best = i; }
  });
  return best;
}

if (typeof module !== "undefined") module.exports = { TR_HOP, trMedian, trSmooth, trPct, trAnalyze, trSplitOf, trPlan, trDur, trSides, trGuess };

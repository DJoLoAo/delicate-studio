const SC_CAL = -20 * Math.log10(0.42 / 2);
const sc = { open: false, an: null, raf: 0, hold: null, corr: 0, gain: 1, last: 0, buf: null };

function scWire(ctx, node, ch) {
  const split = ctx.createChannelSplitter(Math.max(2, ch));
  const L = new AnalyserNode(ctx, { fftSize: 2048 }), R = new AnalyserNode(ctx, { fftSize: 2048 });
  const S = new AnalyserNode(ctx, { fftSize: 8192, smoothingTimeConstant: 0.6, minDecibels: -110, maxDecibels: 0 });
  node.connect(split);
  split.connect(L, 0);
  split.connect(R, ch > 1 ? 1 : 0);
  node.connect(S);
  sc.an = { L, R, S, ch, sr: ctx.sampleRate, l: new Float32Array(2048), r: new Float32Array(2048), s: new Float32Array(S.frequencyBinCount) };
  sc.hold = null;
}

function scToggle(force) {
  sc.open = typeof force === "boolean" ? force : !sc.open;
  $("scope").classList.toggle("hidden", !sc.open);
  document.querySelectorAll(".scbtn").forEach(b => b.classList.toggle("on", sc.open));
  try { localStorage.setItem("studioScope", sc.open ? "1" : "0"); } catch {}
  if (sc.open && !sc.raf) sc.raf = requestAnimationFrame(scDraw);
}

function scFit(cv) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
  const g = cv.getContext("2d");
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  return { g, W, H };
}

function scPlaying() { return ed.play.on || ses.play.on; }

function scDraw(now) {
  sc.raf = 0;
  if (!sc.open) return;
  const dt = sc.last ? Math.min(0.2, (now - sc.last) / 1000) : 0;
  sc.last = now;
  const A = sc.an, on = !!A && scPlaying();
  if (on) {
    A.L.getFloatTimeDomainData(A.l);
    A.R.getFloatTimeDomainData(A.r);
    A.S.getFloatFrequencyData(A.s);
  }
  scSpectrum(on, dt);
  scVector(on, dt);
  sc.raf = requestAnimationFrame(scDraw);
}

function scSpectrum(on, dt) {
  const { g, W, H } = scFit($("scSpec"));
  const A = sc.an, L = 28, B = 14, T = 4, iw = W - L - 4, ih = H - T - B;
  g.fillStyle = TH.graph;
  g.fillRect(0, 0, W, H);
  const ny = A ? A.sr / 2 : 24000, lo = 20, hi = Math.min(20000, ny);
  const xf = f => L + (Math.log(f) - Math.log(lo)) / (Math.log(hi) - Math.log(lo)) * iw;
  const yd = d => T + Math.min(1, Math.max(0, -d / 90)) * ih;
  g.font = thFont(9);
  g.lineWidth = 1;
  g.textAlign = "right";
  g.textBaseline = "middle";
  for (let d = 0; d >= -90; d -= 18) {
    const y = Math.round(yd(d)) + 0.5;
    g.strokeStyle = tw(0.06);
    g.beginPath(); g.moveTo(L, y); g.lineTo(L + iw, y); g.stroke();
    g.fillStyle = TH.glabel;
    g.fillText(String(d), L - 4, y);
  }
  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000]) {
    if (f > hi) continue;
    const x = Math.round(xf(f)) + 0.5;
    g.strokeStyle = tw(0.06);
    g.beginPath(); g.moveTo(x, T); g.lineTo(x, T + ih); g.stroke();
    g.fillStyle = TH.glabel;
    g.fillText(f >= 1000 ? f / 1000 + "k" : String(f), x, H - 2);
  }
  if (!A) return;
  const n = A.s.length, bin = A.sr / (2 * n), cols = Math.max(2, Math.round(iw)), curve = new Float32Array(cols);
  for (let i = 0; i < cols; i++) {
    const f0 = lo * Math.pow(hi / lo, i / cols), f1 = lo * Math.pow(hi / lo, (i + 1) / cols);
    let b0 = Math.floor(f0 / bin), b1 = Math.max(b0 + 1, Math.ceil(f1 / bin));
    let m = -200;
    for (let b = b0; b < Math.min(n, b1); b++) m = Math.max(m, on ? A.s[b] : -200);
    if (b1 - b0 <= 1 && on) { const x = f0 / bin - b0; m = A.s[Math.min(n - 1, b0)] * (1 - x) + A.s[Math.min(n - 1, b0 + 1)] * x; }
    curve[i] = m + SC_CAL;
  }
  if (!sc.hold || sc.hold.length !== cols) sc.hold = new Float32Array(cols).fill(-200);
  for (let i = 0; i < cols; i++) sc.hold[i] = Math.max(curve[i], sc.hold[i] - 12 * dt);
  g.save();
  g.beginPath();
  g.rect(L, T, iw, ih);
  g.clip();
  g.beginPath();
  g.moveTo(L, T + ih);
  for (let i = 0; i < cols; i++) g.lineTo(L + i, yd(curve[i]));
  g.lineTo(L + iw, T + ih);
  g.closePath();
  g.fillStyle = tc("gblue", 0.35);
  g.fill();
  g.strokeStyle = TH.gblue;
  g.lineWidth = 1.2;
  g.beginPath();
  for (let i = 0; i < cols; i++) { const y = yd(curve[i]); if (i) g.lineTo(L + i, y); else g.moveTo(L, y); }
  g.stroke();
  g.strokeStyle = tc("ggold", 0.8);
  g.lineWidth = 1;
  g.beginPath();
  for (let i = 0; i < cols; i++) { const y = yd(sc.hold[i]); if (i) g.lineTo(L + i, y); else g.moveTo(L, y); }
  g.stroke();
  g.restore();
}

function scVector(on, dt) {
  const cv = $("scVec"), { g, W, H } = scFit(cv), A = sc.an;
  const S = Math.min(W, H), cx = W / 2, cy = H / 2, r = S / 2 - 6;
  g.fillStyle = TH.graph;
  g.fillRect(0, 0, W, H);
  g.strokeStyle = tw(0.08);
  g.lineWidth = 1;
  g.beginPath();
  g.moveTo(cx, cy - r); g.lineTo(cx, cy + r);
  g.moveTo(cx - r, cy); g.lineTo(cx + r, cy);
  g.moveTo(cx - r * 0.7071, cy - r * 0.7071); g.lineTo(cx + r * 0.7071, cy + r * 0.7071);
  g.moveTo(cx + r * 0.7071, cy - r * 0.7071); g.lineTo(cx - r * 0.7071, cy + r * 0.7071);
  g.stroke();
  g.fillStyle = TH.glabel;
  g.font = thFont(9);
  g.textAlign = "center";
  g.fillText("M", cx, 11);
  g.fillText("L", cx - r * 0.7071 + 6, cy - r * 0.7071 + 4);
  g.fillText("R", cx + r * 0.7071 - 6, cy - r * 0.7071 + 4);
  let corr = sc.corr, pk = 0;
  if (on && A) {
    const l = A.l, rr = A.r, n = l.length;
    let lr = 0, ll = 0, r2 = 0;
    for (let i = 0; i < n; i++) { lr += l[i] * rr[i]; ll += l[i] * l[i]; r2 += rr[i] * rr[i]; pk = Math.max(pk, Math.abs(l[i]), Math.abs(rr[i])); }
    const c = ll > 1e-10 && r2 > 1e-10 ? lr / Math.sqrt(ll * r2) : 0;
    const k = 1 - Math.exp(-dt / 0.3);
    corr += (c - corr) * k;
    sc.gain = Math.max(0.05, pk > sc.gain ? pk : sc.gain + (pk - sc.gain) * (1 - Math.exp(-dt / 1.5)));
    const sx = r / sc.gain / Math.SQRT2;
    g.fillStyle = tc("gblue", 0.55);
    for (let i = 0; i < n; i++) {
      const x = cx + (rr[i] - l[i]) * sx, y = cy - (l[i] + rr[i]) * sx;
      g.fillRect(x, y, 1.3, 1.3);
    }
  } else corr += (0 - corr) * Math.min(1, dt * 2);
  sc.corr = corr;
  const bar = $("scCorr"), b = scFit(bar), bw = b.W, bh = b.H, mid = bw / 2;
  b.g.fillStyle = TH.meterBg;
  b.g.fillRect(0, 0, bw, bh);
  b.g.fillStyle = tw(0.2);
  b.g.fillRect(mid - 0.5, 0, 1, bh);
  const x = mid + corr * (bw / 2 - 2);
  b.g.fillStyle = corr < -0.05 ? TH.peak : corr < 0.3 ? TH.gold : TH.blue;
  b.g.fillRect(Math.min(mid, x), 2, Math.abs(x - mid), bh - 4);
  $("scCorrV").textContent = (corr >= 0 ? "+" : "−") + Math.abs(corr).toFixed(2);
  $("scCorrV").classList.toggle("bad", corr < -0.05);
  $("scMono").classList.toggle("hidden", !(A && A.ch === 1));
}

function wireScope() {
  $("scX").addEventListener("click", () => scToggle(false));
  document.querySelectorAll(".scbtn").forEach(b => b.addEventListener("click", e => { e.stopPropagation(); scToggle(); }));
  winDrag($("scope"), "studioScopePos");
  let v = "0";
  try { v = localStorage.getItem("studioScope") || "0"; } catch {}
  if (v === "1") scToggle(true);
}

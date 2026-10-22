const SIL = -1;

function clipLen(list) {
  let n = 0;
  for (const s of list) n += s[3];
  return n;
}

function contiguous(a, b) {
  if (a[0] !== b[0]) return false;
  if (a[0] === SIL) return true;
  return a[1] === b[1] && a[2] + a[3] === b[2];
}

function mergeList(list) {
  const out = [];
  for (const s of list) {
    if (s[3] <= 0) continue;
    const last = out[out.length - 1];
    if (last && contiguous(last, s)) out[out.length - 1] = [last[0], last[1], last[2], last[3] + s[3]];
    else out.push(s.slice());
  }
  return out;
}

function sliceList(list, a, b) {
  const out = [];
  let t = 0;
  for (const s of list) {
    const s0 = t, s1 = t + s[3];
    t = s1;
    if (s1 <= a) continue;
    if (s0 >= b) break;
    const from = Math.max(a, s0), to = Math.min(b, s1);
    if (to > from) out.push([s[0], s[1], s[0] === SIL ? 0 : s[2] + (from - s0), to - from]);
  }
  return out;
}

function fadeMix(a, b, linear) {
  const n = a.length, out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i + 0.5) / n, sx = 0.5 - 0.5 * Math.cos(Math.PI * x);
    let wi, wo;
    if (linear) { wi = sx; wo = 1 - sx; } else { wi = Math.sin(sx * Math.PI / 2); wo = Math.cos(sx * Math.PI / 2); }
    out[i] = a[i] * wo + b[i] * wi;
  }
  return out;
}

function fadeGain(x, shape, k) {
  const u = x <= 0 ? 0 : x >= 1 ? 1 : x, s = -6 * k;
  const v = Math.abs(s) < 1e-4 ? u : (Math.exp(s * u) - 1) / (Math.exp(s) - 1);
  return shape === "cos" ? 0.5 - 0.5 * Math.cos(Math.PI * v) : v;
}

function joinFix(list, j, X, io) {
  const A = list[j - 1], B = list[j];
  if (!A || !B) return;
  if (contiguous(A, B)) { list.splice(j - 1, 2, [A[0], A[1], A[2], A[3] + B[3]]); return; }
  if (A[0] === SIL && B[0] === SIL) return;
  let x = Math.min(X, A[3], B[3]);
  if (x < 8) return;
  const aCont = A[0] === SIL ? Infinity : io.srcLen(A[0]) - (A[2] + A[3]);
  const bPre = B[0] === SIL ? Infinity : B[2];
  const linear = A[0] === B[0] && A[0] !== SIL && A[1] === B[1] && Math.abs(B[2] - (A[2] + A[3])) < io.sampleRate * 0.05;
  const rd = (src, c, f, n) => src === SIL ? new Float32Array(n) : io.read(src, c, f, n);
  const post = A[0] !== SIL || bPre < x;
  if (post && aCont >= x) {
    const a = rd(A[0], A[1], A[2] + A[3], x), b = rd(B[0], B[1], B[2], x);
    const id = io.alloc(fadeMix(a, b, linear));
    const rest = B[3] - x;
    const repl = [[id, 0, 0, x]];
    if (rest > 0) repl.push([B[0], B[1], B[0] === SIL ? 0 : B[2] + x, rest]);
    list.splice(j, 1, ...repl);
  } else if (bPre >= x) {
    const a = rd(A[0], A[1], A[2] + A[3] - x, x), b = rd(B[0], B[1], B[0] === SIL ? 0 : B[2] - x, x);
    const id = io.alloc(fadeMix(a, b, linear));
    const keep = A[3] - x;
    const repl = [];
    if (keep > 0) repl.push([A[0], A[1], A[2], keep]);
    repl.push([id, 0, 0, x]);
    list.splice(j - 1, 1, ...repl);
  }
}

function spliceAt(left, mid, right, X, io) {
  const list = mergeList(left);
  const j1 = list.length;
  for (const s of mid) list.push(s.slice());
  const j2 = list.length;
  for (const s of right) list.push(s.slice());
  if (X > 0) {
    if (mid.length && right.length && j2 > 0) joinFix(list, j2, X, io);
    if (j1 > 0 && j1 < list.length) joinFix(list, j1, X, io);
  }
  return mergeList(list);
}

function opDelete(clip, a, b, X, io) {
  return clip.map(list => {
    const F = clipLen(list);
    return spliceAt(sliceList(list, 0, a), [], sliceList(list, b, F), X, io);
  });
}

function opInsert(clip, t, ins, X, io) {
  return clip.map((list, c) => {
    const F = clipLen(list);
    return spliceAt(sliceList(list, 0, t), ins[c], sliceList(list, t, F), X, io);
  });
}

function opSilence(clip, a, b, chans, X, io) {
  return clip.map((list, c) => {
    if (!chans[c]) return list.map(s => s.slice());
    const F = clipLen(list);
    return spliceAt(sliceList(list, 0, a), [[SIL, 0, 0, b - a]], sliceList(list, b, F), X, io);
  });
}

function opReplace(clip, a, b, ins, X, io) {
  return clip.map((list, c) => {
    const F = clipLen(list);
    return spliceAt(sliceList(list, 0, a), ins[c], sliceList(list, b, F), X, io);
  });
}

function opOverwrite(clip, a, ins, X, io) {
  return clip.map((list, c) => {
    if (!ins[c]) return list.map(s => s.slice());
    const F = clipLen(list), n = Math.min(clipLen(ins[c]), F - a);
    if (n <= 0) return list.map(s => s.slice());
    return spliceAt(sliceList(list, 0, a), sliceList(ins[c], 0, n), sliceList(list, a + n, F), X, io);
  });
}

function patchList(list, spans) {
  const out = [];
  let i = 0, t = 0;
  const take = (a, b) => {
    while (i < list.length && t + list[i][3] <= a) { t += list[i][3]; i++; }
    let j = i, tj = t;
    while (j < list.length && tj < b) {
      const s = list[j], s0 = tj, s1 = tj + s[3];
      const from = Math.max(a, s0), to = Math.min(b, s1);
      if (to > from) out.push([s[0], s[1], s[0] === SIL ? 0 : s[2] + (from - s0), to - from]);
      tj = s1;
      j++;
    }
  };
  let pos = 0;
  for (const [a, b, segs] of spans) {
    take(pos, a);
    for (const s of segs) out.push(s.slice());
    pos = b;
  }
  take(pos, Infinity);
  return mergeList(out);
}

function opPatch(clip, spans) {
  return clip.map((list, c) => spans[c] && spans[c].length ? patchList(list, spans[c]) : list.map(s => s.slice()));
}

function sameSeg(a, b) { return a === b || (a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3]); }

function diffList(prev, next) {
  let p = 0;
  const lim = Math.min(prev.length, next.length);
  while (p < lim && sameSeg(prev[p], next[p])) { next[p] = prev[p]; p++; }
  let s = 0;
  while (s < lim - p && sameSeg(prev[prev.length - 1 - s], next[next.length - 1 - s])) { next[next.length - 1 - s] = prev[prev.length - 1 - s]; s++; }
  return [p, s, next.slice(p, next.length - s)];
}

function applyDiff(prev, d) {
  const [p, s, mid] = d;
  return prev.slice(0, p).concat(mid.map(x => x.slice()), s ? prev.slice(prev.length - s) : []);
}

function opCrop(clip, a, b) {
  return clip.map(list => mergeList(sliceList(list, a, b)));
}

function opCopy(clip, a, b, chans) {
  const lists = [];
  clip.forEach((list, c) => { if (chans[c]) lists.push(mergeList(sliceList(list, a, b))); });
  return lists;
}

function cumOf(list) {
  const cum = new Array(list.length);
  let t = 0;
  for (let i = 0; i < list.length; i++) { cum[i] = t; t += list[i][3]; }
  return cum;
}

function readList(list, cum, start, count, out, off, readSrc) {
  let lo = 0, hi = list.length - 1, i = 0;
  while (lo <= hi) { const m = (lo + hi) >> 1; if (cum[m] <= start) { i = m; lo = m + 1; } else hi = m - 1; }
  let done = 0, t = start;
  if (t < 0) { const z = Math.min(count, -t); out.fill(0, off, off + z); done = z; t += z; }
  while (done < count) {
    if (i >= list.length) { out.fill(0, off + done, off + count); break; }
    const s = list[i], into = t - cum[i];
    const n = Math.min(count - done, s[3] - into);
    if (n <= 0) { i++; continue; }
    if (s[0] === SIL) out.fill(0, off + done, off + done + n);
    else readSrc(s[0], s[1], s[2] + into, n, out, off + done);
    done += n;
    t += n;
    i++;
  }
}

function mapMarks(marks, h) {
  if (!marks.length || h.ch) return marks;
  const op = h.op;
  if (op !== "delete" && op !== "cut" && op !== "paste" && op !== "insert" && op !== "crop") return marks;
  const a = h.a, b = h.b, n = op === "paste" || op === "insert" ? h.n : 0, d = n - (b - a);
  const out = [];
  let changed = false;
  for (const m of marks) {
    if (m.kind === "view") { out.push(m); continue; }
    let s, e;
    if (op === "crop") {
      if (m.kind === "point") { if (m.a < a || m.a > b) { changed = true; continue; } s = m.a - a; e = s; }
      else { s = Math.max(m.a, a) - a; e = Math.min(m.b, b) - a; if (e - s < 1) { changed = true; continue; } }
    } else if (m.kind === "point") {
      const p = m.a;
      if (p < a || (p === a && a < b)) s = p;
      else if (p >= b) s = p + d;
      else { changed = true; continue; }
      e = s;
    } else {
      s = m.a < a ? m.a : m.a >= b ? m.a + d : a + n;
      e = m.b <= a ? m.b : m.b >= b ? m.b + d : a;
      if (e - s < 1) { changed = true; continue; }
    }
    if (s !== m.a || (m.kind === "range" && e !== m.b)) { changed = true; out.push(Object.assign({}, m, m.kind === "range" ? { a: s, b: e } : { a: s })); }
    else out.push(m);
  }
  return changed ? out : marks;
}

if (typeof module !== "undefined") module.exports = { SIL, clipLen, mergeList, sliceList, joinFix, opDelete, opInsert, opSilence, opReplace, opOverwrite, opPatch, patchList, opCrop, opCopy, diffList, applyDiff, cumOf, readList, fadeMix, fadeGain, mapMarks };

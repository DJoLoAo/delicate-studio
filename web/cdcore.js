const CI_LEAD = 150;
const CI_GAP = 11400;
const CI_SPF = 588;
const CI_SKIP = 5 * CI_SPF;
const CI_REACH = 5 * CI_SPF - 1;

function ciExt80(b, o) {
  const e = ((b[o] & 0x7f) << 8 | b[o + 1]) - 16383;
  let m = 0;
  for (let i = 0; i < 8; i++) m = m * 256 + b[o + 2 + i];
  return m ? Math.round(m * Math.pow(2, e - 63)) : 0;
}

function ciAiff(b) {
  const u = b instanceof Uint8Array ? b : new Uint8Array(b), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), tag = o => String.fromCharCode(u[o], u[o + 1], u[o + 2], u[o + 3]);
  if (u.length < 12 || tag(0) !== "FORM" || (tag(8) !== "AIFF" && tag(8) !== "AIFC")) return null;
  const aifc = tag(8) === "AIFC";
  let o = 12, comm = null, data = -1, le = false;
  while (o + 8 <= u.length) {
    const id = tag(o), n = dv.getUint32(o + 4);
    if (id === "COMM" && o + 8 + 18 <= u.length) {
      comm = { ch: dv.getUint16(o + 8), frames: dv.getUint32(o + 10), bits: dv.getUint16(o + 14), sr: ciExt80(u, o + 16) };
      if (aifc && o + 8 + 22 <= u.length) { const c = tag(o + 26); if (c === "sowt") le = true; else if (c !== "NONE" && c !== "twos") return { bad: "compressed" }; }
    }
    if (id === "SSND" && o + 16 <= u.length) { data = o + 16 + dv.getUint32(o + 8); break; }
    o += 8 + n + (n & 1);
  }
  if (!comm || data < 0) return null;
  return Object.assign(comm, { data, le });
}

function ciToc(lens, pregap, data) {
  const offsets = [CI_LEAD + (pregap || 0)];
  for (let i = 0; i + 1 < lens.length; i++) offsets.push(offsets[i] + lens[i]);
  const end = offsets[offsets.length - 1] + lens[lens.length - 1], all = offsets.slice();
  let leadout = end;
  if (data > 0) { all.push(end + CI_GAP); leadout = end + CI_GAP + data; }
  return { offsets, all, end, leadout, lens: lens.slice(), pregap: pregap || 0, data: data || 0 };
}

function ciTocPlist(sessions) {
  const tr = [];
  for (const s of sessions) for (const t of s.tracks) tr.push(Object.assign({ session: s.n }, t));
  tr.sort((a, b) => a.start - b.start);
  if (!tr.length) return null;
  const base = Math.min(...tr.map(t => t.start)) < CI_LEAD ? CI_LEAD : 0;
  const audio = tr.filter(t => !t.data), first = sessions[0], last = sessions[sessions.length - 1];
  if (!audio.length) return null;
  const offsets = audio.map(t => t.start + base), all = tr.map(t => t.start + base);
  const s1 = audio[audio.length - 1].session, endS = sessions.find(s => s.n === s1) || first;
  const end = endS.leadout + base, leadout = last.leadout + base;
  const lens = offsets.map((v, i) => (i + 1 < offsets.length ? offsets[i + 1] : end) - v);
  const dataTr = tr.filter(t => t.data);
  return { offsets, all, end, leadout, lens, pregap: offsets[0] - CI_LEAD, data: dataTr.length ? leadout - (dataTr[dataTr.length - 1].start + base) : 0 };
}

async function ciMbId(toc) {
  const h = (v, n) => v.toString(16).toUpperCase().padStart(n, "0");
  let s = h(1, 2) + h(toc.offsets.length, 2) + h(toc.end, 8);
  for (let i = 0; i < 99; i++) s += h(toc.offsets[i] || 0, 8);
  const d = new Uint8Array(await crypto.subtle.digest("SHA-1", new TextEncoder().encode(s)));
  let bin = "";
  for (const x of d) bin += String.fromCharCode(x);
  return btoa(bin).replace(/\+/g, ".").replace(/\//g, "_").replace(/=/g, "-");
}

function ciMbToc(toc) { return [1, toc.offsets.length, toc.end].concat(toc.offsets).join(" "); }

function ciFreedb(toc) {
  const ds = v => { let s = 0; for (; v > 0; v = Math.floor(v / 10)) s += v % 10; return s; };
  let n = 0;
  for (const v of toc.all) n += ds(Math.floor(v / 75));
  const t = Math.floor(toc.leadout / 75) - Math.floor(toc.all[0] / 75);
  return (((n % 255) << 24) | (t << 8) | toc.all.length) >>> 0;
}

function ciArIds(toc) {
  let a = 0, b = 0;
  toc.offsets.forEach((v, i) => { const l = v - CI_LEAD; a += l; b += (l || 1) * (i + 1); });
  const lo = toc.leadout - CI_LEAD;
  a += lo;
  b += lo * (toc.offsets.length + 1);
  return [a >>> 0, b >>> 0];
}

function ciHex(v) { return (v >>> 0).toString(16).padStart(8, "0"); }

function ciArName(toc) {
  const [a, b] = ciArIds(toc);
  return "dBAR-" + String(toc.offsets.length).padStart(3, "0") + "-" + ciHex(a) + "-" + ciHex(b) + "-" + ciHex(ciFreedb(toc)) + ".bin";
}

function ciDbar(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out = [];
  let o = 0;
  while (o + 13 <= u.length) {
    const n = u[o], p = { n, id1: dv.getUint32(o + 1, true), id2: dv.getUint32(o + 5, true), cddb: dv.getUint32(o + 9, true), tracks: [] };
    o += 13;
    if (o + n * 9 > u.length) break;
    for (let i = 0; i < n; i++, o += 9) p.tracks.push({ c: u[o], crc: dv.getUint32(o + 1, true), f450: dv.getUint32(o + 5, true) });
    out.push(p);
  }
  return out;
}

function ciAcc(n, first, last) { return { mult: 1, from: first ? CI_SKIP : 1, to: last ? n - CI_SKIP : n, v1: 0, hi: 0 }; }

function ciPush(st, w, n) {
  let m = st.mult, v1 = st.v1, hi = st.hi;
  const from = st.from, to = st.to;
  for (let i = 0; i < n; i++, m++) {
    if (m < from || m > to) continue;
    const x = w[i];
    if (!x) continue;
    const a = (x >>> 16) * m, b = (x & 0xffff) * m, t = a + Math.floor(b / 65536);
    v1 = (v1 + Math.imul(x, m)) >>> 0;
    hi = (hi + Math.floor(t / 65536)) >>> 0;
  }
  st.mult = m; st.v1 = v1; st.hi = hi;
}

function ciDone(st) { return { v1: st.v1 >>> 0, v2: (st.v1 + st.hi) >>> 0 }; }

function ciF450(w, at) {
  let s = 0;
  for (let k = 0; k < CI_SPF; k++) s = (s + Math.imul(w[at + k], k + 1)) >>> 0;
  return s;
}

function ciTocFrom(info) {
  const all = info.toc.tracks, audio = all.filter(t => !t.data);
  if (!audio.length) return null;
  const offsets = audio.map(t => t.lba + CI_LEAD), lens = audio.map((t, i) => info.ends[i] - t.lba);
  const last = audio[audio.length - 1], end = last.lba + lens[lens.length - 1] + CI_LEAD;
  const dataT = all.filter(t => t.data);
  return { offsets, all: all.map(t => t.lba + CI_LEAD), end, leadout: info.toc.leadout + CI_LEAD, lens, pregap: audio[0].lba, data: dataT.length ? info.toc.leadout - dataT[dataT.length - 1].lba : 0 };
}

function ciOffsets(buf) {
  const u = buf instanceof Uint8Array ? buf : new Uint8Array(buf), dv = new DataView(u.buffer, u.byteOffset, u.byteLength), out = [];
  for (let o = 0; o + 69 <= u.length; o += 69) {
    let name = "";
    for (let i = 0; i < 33 && u[o + 2 + i]; i++) name += String.fromCharCode(u[o + 2 + i]);
    out.push({ name: name.trim(), offset: dv.getInt16(o, true) });
  }
  return out;
}

function ciNorm(s) { return String(s || "").toLowerCase().replace(/\s+/g, " ").replace(/\s*-\s*/g, " - ").trim(); }

function ciDriveOffset(list, name) {
  const n = ciNorm(name), flat = x => ciNorm(x).replace(/[\s-]/g, "");
  if (!n) return null;
  return list.find(x => ciNorm(x.name) === n) || list.find(x => flat(x.name) === flat(name)) || null;
}

function ciCdText(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), parts = { 128: [], 129: [] }, first = {};
  for (let o = 0; o + 18 <= u.length; o += 18) {
    const type = u[o], tr = u[o + 1] & 0x7f, blk = (u[o + 3] >> 4) & 7, dbcc = u[o + 3] & 0x80;
    if (blk !== 0 || dbcc || !(type in parts)) continue;
    if (!(type in first)) first[type] = tr;
    for (let i = 4; i < 16; i++) parts[type].push(u[o + i]);
  }
  const split = type => {
    const out = [], b = parts[type];
    let cur = "";
    for (const c of b) { if (c === 0) { out.push(cur); cur = ""; } else cur += c === 9 && out.length ? "\t" : String.fromCharCode(c); }
    while (out.length && !out[out.length - 1]) out.pop();
    return out.map((x, i) => x === "\t" ? out[i - 1] || "" : x);
  };
  const T = split(128), P = split(129), t0 = first[128] || 0, p0 = first[129] || 0, n = Math.max(T.length + t0, P.length + p0);
  if (!T.length && !P.length) return null;
  const at = (arr, start, k) => (k - start >= 0 && k - start < arr.length ? arr[k - start] : "").trim();
  const tracks = [];
  for (let k = 1; k < n; k++) tracks.push({ title: at(T, t0, k), performer: at(P, p0, k) });
  return { title: at(T, t0, 0), performer: at(P, p0, 0), tracks };
}

if (typeof module !== "undefined") module.exports = { ciTocFrom, ciOffsets, ciDriveOffset, ciCdText, ciAiff, ciToc, ciTocPlist, ciMbId, ciMbToc, ciFreedb, ciArIds, ciArName, ciDbar, ciAcc, ciPush, ciDone, ciF450, ciHex, CI_SPF, CI_SKIP, CI_REACH };

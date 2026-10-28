const DDP_SPF = 588, DDP_PREGAP = 150, DDP_TEXT = ["title", "performer", "songwriter", "composer", "arranger", "message"];

function ddpLatin(s) {
  const out = [];
  for (const ch of String(s || "").normalize("NFC")) {
    const c = ch.codePointAt(0);
    out.push(c < 32 || c === 127 ? 32 : c > 255 ? 63 : c);
  }
  return out;
}

function ddpAscii(s) { return String.fromCharCode(...ddpLatin(s)); }

function ddpT(s, n) { return ddpAscii(s).slice(0, n).padEnd(n, " "); }

function ddpN(v, n) { return (v === null || v === undefined || v === "" ? "" : String(v)).padStart(n, " ").slice(-n); }

function ddpBytes(s) { const b = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; }

function ddpMsf(f) {
  const p = v => String(v).padStart(2, "0");
  return p(Math.floor(f / 4500)) + p(Math.floor(f / 75) % 60) + p(f % 75);
}

function ddpCueMsf(f) { const s = ddpMsf(f); return s.slice(0, 2) + ":" + s.slice(2, 4) + ":" + s.slice(4); }

function ddpEan(upc) { const u = String(upc || "").replace(/\D/g, ""); return u.length === 12 ? "0" + u : u.length === 13 ? u : ""; }

function ddpId(upc, mid) {
  return ddpBytes(("DDP 2.00" + ddpT(ddpEan(upc), 13) + " ".repeat(17) + ddpT(mid, 48) + " " + "CD").padEnd(128, " "));
}

function ddpMsPacket(p) {
  const d = p.kind === "da";
  const s = "VVVM" + (d ? "D0" : "S0") + " ".repeat(8) + ddpN(p.len, 8) + " ".repeat(8)
    + ddpT(d ? "" : p.kind === "pq" ? "PQ DESCR" : "CDTEXT", 8) + (d ? "DA71" : "    ") + " ".repeat(4) + ddpN(d ? p.pre : "", 4) + " ".repeat(4) + " "
    + (p.kind === "cdtext" ? "00" : "  ") + " ".repeat(14) + ddpN(17, 3) + ddpT(p.file, 17);
  return s.padEnd(128, " ");
}

function ddpMs(list) { return ddpBytes(list.map(ddpMsPacket).join("")); }

function ddpPqEntries(tracks, sectors) {
  const out = [{ tk: "00", ix: "00", at: 0 }];
  tracks.forEach((k, i) => {
    const tk = String(i + 1).padStart(2, "0");
    const idx = (k.idx || []).slice().sort((a, b) => a - b);
    const pre = i === 0 ? 0 : k.pre;
    if (pre !== null && pre !== undefined && pre < k.at) out.push({ tk, ix: "00", at: pre, isrc: k.isrc });
    out.push({ tk, ix: "01", at: k.at, isrc: k.isrc });
    idx.forEach((x, j) => out.push({ tk, ix: String(j + 2).padStart(2, "0"), at: x }));
  });
  out.push({ tk: "AA", ix: "01", at: sectors }, { tk: "AA", ix: "01", at: sectors });
  const seen = new Set();
  for (const e of out) { if (e.isrc && !seen.has(e.tk)) seen.add(e.tk); else e.isrc = ""; }
  return out;
}

function ddpPq(tracks, sectors, upc) {
  return ddpBytes(ddpPqEntries(tracks, sectors).map((e, i) => ("VVVS" + e.tk + e.ix + ddpN(ddpMsf(e.at), 8) + "01" + "  " + ddpT(e.isrc, 12) + ddpT(i === 0 ? ddpEan(upc) : "", 13)).padEnd(64, " ")).join(""));
}

function ddpCrc16(b, n) {
  let c = 0;
  for (let i = 0; i < n; i++) {
    c ^= b[i] << 8;
    for (let k = 0; k < 8; k++) c = c & 0x8000 ? ((c << 1) ^ 0x1021) & 0xFFFF : (c << 1) & 0xFFFF;
  }
  return c ^ 0xFFFF;
}

function ddpCdText(disc, tracks) {
  const packs = [], counts = new Array(16).fill(0);
  const pack = (type, tr, pos, payload) => {
    const p = new Uint8Array(18);
    p[0] = type; p[1] = tr; p[2] = packs.length; p[3] = Math.min(15, pos);
    p.set(payload, 4);
    const c = ddpCrc16(p, 16);
    p[16] = c >> 8; p[17] = c & 255;
    packs.push(p);
    counts[type - 0x80]++;
  };
  DDP_TEXT.forEach((f, ti) => {
    const strs = [disc[f] || ""].concat(tracks.map(k => k[f] || ""));
    if (!strs.some(Boolean)) return;
    const bytes = [], owner = [], pos = [];
    strs.forEach((s, tr) => { const b = ddpLatin(s).concat([0]); b.forEach((x, i) => { bytes.push(x); owner.push(tr); pos.push(i); }); });
    for (let o = 0; o < bytes.length; o += 12) {
      const pl = new Uint8Array(12);
      pl.set(bytes.slice(o, o + 12));
      pack(0x80 + ti, owner[o], pos[o], pl);
    }
  });
  if (!packs.length) return null;
  const total = packs.length + 3, info = new Uint8Array(36);
  counts[15] = 3;
  info[0] = 0; info[1] = 1; info[2] = tracks.length; info[3] = 0;
  info.set(counts, 4);
  info[20] = total - 1;
  info[28] = 9;
  for (let i = 0; i < 3; i++) {
    const p = new Uint8Array(18);
    p[0] = 0x8F; p[1] = i; p[2] = packs.length; p[3] = 0;
    p.set(info.subarray(i * 12, i * 12 + 12), 4);
    const c = ddpCrc16(p, 16);
    p[16] = c >> 8; p[17] = c & 255;
    packs.push(p);
  }
  const out = new Uint8Array(packs.length * 18);
  packs.forEach((p, i) => out.set(p, i * 18));
  return out;
}

function ddpCue(disc, tracks, upc, image) {
  const q = s => '"' + ddpAscii(s).replace(/"/g, "'") + '"', L = [];
  if (ddpEan(upc)) L.push("CATALOG " + ddpEan(upc));
  for (const f of DDP_TEXT) if (disc[f]) L.push(f.toUpperCase() + " " + q(disc[f]));
  L.push('FILE "' + image + '" BINARY');
  tracks.forEach((k, i) => {
    L.push("  TRACK " + String(i + 1).padStart(2, "0") + " AUDIO");
    for (const f of DDP_TEXT) if (k[f]) L.push("    " + f.toUpperCase() + " " + q(k[f]));
    if (k.isrc) L.push("    ISRC " + k.isrc);
    const pre = i === 0 ? 0 : k.pre;
    if (pre !== null && pre !== undefined && pre < k.at) L.push("    INDEX 00 " + ddpCueMsf(pre));
    L.push("    INDEX 01 " + ddpCueMsf(k.at));
    (k.idx || []).slice().sort((a, b) => a - b).forEach((x, j) => L.push("    INDEX " + String(j + 2).padStart(2, "0") + " " + ddpCueMsf(x)));
  });
  return ddpBytes(L.join("\n") + "\n");
}

function ddpPqList(disc, tracks, sectors, upc, head) {
  const L = [], c = s => ddpCueMsf(s);
  L.push(ddpAscii(disc.title || "") + (disc.performer ? " - " + ddpAscii(disc.performer) : ""));
  for (const h of head || []) L.push(ddpAscii(h));
  L.push("UPC/EAN: " + (ddpEan(upc) || "-"));
  L.push("Tracks: " + tracks.length + "   Total: " + c(sectors) + "   Lead-out: " + c(sectors));
  L.push("");
  L.push(["Tr", "Ix", "Start", "Length", "ISRC        ", "Title / Performer"].join("  "));
  tracks.forEach((k, i) => {
    const next = i + 1 < tracks.length ? tracks[i + 1].at : sectors;
    const pre = i === 0 ? 0 : k.pre;
    const tr = String(i + 1).padStart(2, "0");
    if (pre !== null && pre !== undefined && pre < k.at) L.push([tr, "00", c(pre), c(k.at - pre), " ".repeat(12), ""].join("  "));
    L.push([tr, "01", c(k.at), c(next - k.at), (k.isrc || "-").padEnd(12, " "), ddpAscii(k.title || "") + (k.performer ? " / " + ddpAscii(k.performer) : "")].join("  ").trimEnd());
  });
  L.push(["AA", "01", c(sectors)].join("  "));
  return ddpBytes(L.join("\r\n") + "\r\n");
}

const DDP_CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();

function ddpCrc32(c, b) {
  c = ~c >>> 0;
  for (let i = 0; i < b.length; i++) c = DDP_CRC[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

const DDP_MD5K = (() => { const k = new Uint32Array(64); for (let i = 0; i < 64; i++) k[i] = Math.floor(Math.abs(Math.sin(i + 1)) * 4294967296) >>> 0; return k; })();
const DDP_MD5S = [7, 12, 17, 22, 5, 9, 14, 20, 4, 11, 16, 23, 6, 10, 15, 21];

function ddpMd5New() { return { h: new Uint32Array([0x67452301, 0xEFCDAB89, 0x98BADCFE, 0x10325476]), buf: new Uint8Array(64), n: 0, len: 0, w: new Uint32Array(16) }; }

function ddpMd5Block(st, b, o) {
  const w = st.w, h = st.h;
  for (let i = 0; i < 16; i++) w[i] = b[o + i * 4] | (b[o + i * 4 + 1] << 8) | (b[o + i * 4 + 2] << 16) | (b[o + i * 4 + 3] << 24);
  let a = h[0], bb = h[1], c = h[2], d = h[3];
  for (let i = 0; i < 64; i++) {
    let f, g;
    if (i < 16) { f = (bb & c) | (~bb & d); g = i; }
    else if (i < 32) { f = (d & bb) | (~d & c); g = (5 * i + 1) & 15; }
    else if (i < 48) { f = bb ^ c ^ d; g = (3 * i + 5) & 15; }
    else { f = c ^ (bb | ~d); g = (7 * i) & 15; }
    const s = DDP_MD5S[(i >> 4) * 4 + (i & 3)], x = (a + f + DDP_MD5K[i] + w[g]) | 0;
    a = d; d = c; c = bb;
    bb = (bb + ((x << s) | (x >>> (32 - s)))) | 0;
  }
  h[0] += a; h[1] += bb; h[2] += c; h[3] += d;
}

function ddpMd5Push(st, b) {
  let i = 0;
  st.len += b.length;
  if (st.n) {
    while (st.n < 64 && i < b.length) st.buf[st.n++] = b[i++];
    if (st.n < 64) return;
    ddpMd5Block(st, st.buf, 0);
    st.n = 0;
  }
  for (; i + 64 <= b.length; i += 64) ddpMd5Block(st, b, i);
  while (i < b.length) st.buf[st.n++] = b[i++];
}

function ddpMd5Hex(st) {
  const bits = st.len * 8, pad = new Uint8Array(((st.n < 56 ? 56 : 120) - st.n) + 8);
  pad[0] = 0x80;
  const e = pad.length - 8;
  for (let i = 0; i < 8; i++) pad[e + i] = Math.floor(bits / Math.pow(2, 8 * i)) & 255;
  ddpMd5Push(st, pad);
  let s = "";
  for (let i = 0; i < 4; i++) for (let k = 0; k < 4; k++) s += ((st.h[i] >>> (8 * k)) & 255).toString(16).padStart(2, "0");
  return s;
}

function ddpMd5(b) { const st = ddpMd5New(); ddpMd5Push(st, b); return ddpMd5Hex(st); }

function ddpZipTime(d) {
  return { time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1), date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate() };
}

function ddpZipLocal(name, crc, size, when) {
  const n = new TextEncoder().encode(name), b = new Uint8Array(30 + n.length), v = new DataView(b.buffer);
  v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x800, true); v.setUint16(8, 0, true);
  v.setUint16(10, when.time, true); v.setUint16(12, when.date, true);
  v.setUint32(14, crc, true); v.setUint32(18, size, true); v.setUint32(22, size, true);
  v.setUint16(26, n.length, true); v.setUint16(28, 0, true);
  b.set(n, 30);
  return b;
}

function ddpZipEnd(entries, at, when) {
  const parts = [];
  for (const e of entries) {
    const n = new TextEncoder().encode(e.name), b = new Uint8Array(46 + n.length), v = new DataView(b.buffer);
    v.setUint32(0, 0x02014b50, true); v.setUint16(4, 20, true); v.setUint16(6, 20, true); v.setUint16(8, 0x800, true); v.setUint16(10, 0, true);
    v.setUint16(12, when.time, true); v.setUint16(14, when.date, true);
    v.setUint32(16, e.crc, true); v.setUint32(20, e.size, true); v.setUint32(24, e.size, true);
    v.setUint16(28, n.length, true);
    v.setUint32(42, e.off, true);
    b.set(n, 46);
    parts.push(b);
  }
  const cdLen = parts.reduce((s, p) => s + p.length, 0), end = new Uint8Array(22), v = new DataView(end.buffer);
  v.setUint32(0, 0x06054b50, true); v.setUint16(8, entries.length, true); v.setUint16(10, entries.length, true);
  v.setUint32(12, cdLen, true); v.setUint32(16, at, true);
  parts.push(end);
  const out = new Uint8Array(cdLen + 22);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function ddpChecksums(list) {
  return {
    md5: ddpBytes(list.map(x => x.md5 + " *" + x.name).join("\n") + "\n"),
    txt: ddpBytes("[CRC32 Checksum]\n" + list.map(x => x.name + "=" + x.crc.toString(16).toUpperCase().padStart(8, "0")).join("\n") + "\n")
  };
}

if (typeof module !== "undefined") module.exports = { ddpLatin, ddpMsf, ddpEan, ddpId, ddpMs, ddpPq, ddpPqEntries, ddpCdText, ddpCrc16, ddpCue, ddpPqList, ddpCrc32, ddpMd5, ddpMd5New, ddpMd5Push, ddpMd5Hex, ddpZipLocal, ddpZipEnd, ddpZipTime, ddpChecksums, DDP_SPF, DDP_PREGAP };

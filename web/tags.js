const TG_INFO = { INAM: "TITLE", IART: "ARTIST", IPRD: "ALBUM", ICRD: "DATE", IGNR: "GENRE", ICMT: "COMMENT", ITRK: "TRACKNUMBER", IPRT: "TRACKNUMBER", ICOP: "COPYRIGHT" };
const TG_INFO_OUT = { TITLE: "INAM", ARTIST: "IART", ALBUM: "IPRD", DATE: "ICRD", GENRE: "IGNR", COMMENT: "ICMT", TRACKNUMBER: "ITRK", COPYRIGHT: "ICOP" };
const TG_DROP = new Set(["ENCODER", "ENCODEDBY", "ENCODED BY", "ENCODERSETTINGS", "ENCODING", "VENDOR", "CUESHEET", "ITUNSMPB", "ISFT"]);
const TG_LONG = new Set(["LYRICS", "CUESHEET", "UNSYNCEDLYRICS"]);
const TG_MAX = 200;

function tgId(b, o) { return String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]); }
function tgU32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
function tgU32B(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
function tgU64B(b, o) { return tgU32B(b, o) * 4294967296 + tgU32B(b, o + 4); }

function tgText(b, o, n) {
  let e = o;
  const end = Math.min(b.length, o + n);
  while (e < end && b[e] !== 0) e++;
  const raw = b.subarray(o, e);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(raw).trim(); }
  catch { return new TextDecoder("windows-1252").decode(raw).trim(); }
}

function tgKey(k) {
  return String(k || "").toUpperCase().replace(/[^A-Z0-9 _]/g, "").trim().slice(0, 40);
}

function tgClean(list, keep) {
  const out = [], seen = new Set();
  for (const p of Array.isArray(list) ? list : []) {
    if (!Array.isArray(p) || p.length !== 2) continue;
    const k = tgKey(p[0]);
    if (!k || (!keep && TG_DROP.has(k))) continue;
    const v = String(p[1] == null ? "" : p[1]).replace(/\u0000/g, "").trim().slice(0, TG_LONG.has(k) ? 65536 : 1000);
    if (!v || seen.has(k + "\u0001" + v)) continue;
    seen.add(k + "\u0001" + v);
    out.push([k, v]);
    if (out.length >= TG_MAX) break;
  }
  return out;
}

function tgGet(tags, k) {
  const p = (tags || []).find(x => x[0] === k);
  return p ? p[1] : "";
}

function tgAll(tags, k) {
  return (tags || []).filter(x => x[0] === k).map(x => x[1]);
}

function tgMarks(list) {
  const out = [];
  list.sort((x, y) => x.a - y.a || (x.b || x.a) - (y.b || y.a));
  for (const m of list) {
    if (out.length >= 999) break;
    const n = out.length + 1, mk = { id: n, n, kind: m.b > m.a ? "range" : "point", a: m.a, name: String(m.name || "").slice(0, 120), view: null, chans: null };
    if (m.b > m.a) mk.b = m.b;
    if (m.tag) mk.tag = m.tag;
    out.push(mk);
  }
  return out;
}

function tgRiff(read, size) {
  const h = read(0, 12);
  if (h.length < 12) return null;
  const id = tgId(h, 0);
  if ((id !== "RIFF" && id !== "RF64" && id !== "BW64") || tgId(h, 8) !== "WAVE") return null;
  const out = { kind: "wav", tags: [], marks: [], bext: null, rate: 0 };
  const cues = [], labl = {}, note = {}, ltxt = {};
  let pos = 12, big = 0, guard = 0;
  while (pos + 8 <= size && guard++ < 10000) {
    const ch = read(pos, 8);
    if (ch.length < 8) break;
    const cid = tgId(ch, 0);
    let len = tgU32(ch, 4);
    if (cid === "data" && len === 0xFFFFFFFF && big) len = big;
    if (cid === "data" || len > 16 << 20) { pos += 8 + len + (len & 1); continue; }
    const body = read(pos + 8, len);
    if (cid === "ds64" && body.length >= 16) big = tgU32(body, 8) + tgU32(body, 12) * 4294967296;
    else if (cid === "fmt " && body.length >= 8) out.rate = tgU32(body, 4);
    else if (cid === "cue " && body.length >= 4) {
      const k = tgU32(body, 0);
      for (let i = 0; i < k && 4 + i * 24 + 24 <= body.length; i++) {
        const o = 4 + i * 24, p = tgU32(body, o + 4), s = tgU32(body, o + 20);
        cues.push({ id: tgU32(body, o), pos: s || p });
      }
    } else if (cid === "LIST" && body.length >= 4) {
      const type = tgId(body, 0);
      for (let o = 4; o + 8 <= body.length;) {
        const sid = tgId(body, o), sl = tgU32(body, o + 4), sb = body.subarray(o + 8, Math.min(body.length, o + 8 + sl));
        if (type === "INFO" && TG_INFO[sid]) out.tags.push([TG_INFO[sid], tgText(sb, 0, sb.length)]);
        if (type === "adtl" && sb.length >= 4) {
          const cue = tgU32(sb, 0);
          if (sid === "labl") labl[cue] = tgText(sb, 4, sb.length - 4);
          else if (sid === "note") note[cue] = tgText(sb, 4, sb.length - 4);
          else if (sid === "ltxt" && sb.length >= 8) ltxt[cue] = { len: tgU32(sb, 4), text: sb.length > 20 ? tgText(sb, 20, sb.length - 20) : "" };
        }
        o += 8 + sl + (sl & 1);
      }
    } else if (cid === "bext" && body.length >= 346) {
      out.bext = { description: tgText(body, 0, 256), originator: tgText(body, 256, 32), date: tgText(body, 320, 10), time: tgText(body, 330, 8), ref: tgU32(body, 338) + tgU32(body, 342) * 4294967296 };
    }
    pos += 8 + len + (len & 1);
  }
  const seen = new Set(), list = [];
  for (const c of cues) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    const lt = ltxt[c.id];
    list.push({ a: c.pos, b: lt && lt.len > 0 ? c.pos + lt.len : 0, name: labl[c.id] || note[c.id] || (lt && lt.text) || "" });
  }
  out.marks = list;
  return out;
}

function tgFlac(read, size) {
  let pos = 0;
  const h = read(0, 10);
  if (h.length >= 10 && tgId(h, 0).slice(0, 3) === "ID3") pos = 10 + ((h[6] & 127) << 21 | (h[7] & 127) << 14 | (h[8] & 127) << 7 | (h[9] & 127)) + (h[5] & 16 ? 10 : 0);
  if (tgId(read(pos, 4), 0) !== "fLaC") return null;
  pos += 4;
  const out = { kind: "flac", rate: 0, total: 0, cues: [] };
  for (let guard = 0; pos + 4 <= size && guard < 1000; guard++) {
    const bh = read(pos, 4);
    if (bh.length < 4) break;
    const type = bh[0] & 127, last = bh[0] & 128, len = (bh[1] << 16) | (bh[2] << 8) | bh[3];
    if (type === 0 || type === 5) {
      const b = read(pos + 4, len);
      if (type === 0 && b.length >= 18) {
        out.rate = (b[10] << 12) | (b[11] << 4) | (b[12] >> 4);
        out.total = (b[13] & 15) * 4294967296 + tgU32B(b, 14);
      }
      if (type === 5 && b.length >= 396) {
        const nt = b[395];
        let o = 396;
        for (let i = 0; i < nt && o + 36 <= b.length; i++) {
          const off = tgU64B(b, o), num = b[o + 8], isrc = tgText(b, o + 9, 12), ni = b[o + 35];
          let idx1 = null, first = null;
          o += 36;
          for (let j = 0; j < ni && o + 12 <= b.length; j++) {
            const io = tgU64B(b, o), inum = b[o + 8];
            if (first === null) first = io;
            if (inum === 1) idx1 = io;
            o += 12;
          }
          out.cues.push({ n: num, a: off + (idx1 !== null ? idx1 : first !== null ? first : 0), isrc, lead: ni === 0 || num === 170 || num === 255 });
        }
      }
    }
    pos += 4 + len;
    if (last) break;
  }
  return out;
}

function tgCueTime(s) {
  const m = /^(\d+):(\d{1,2}):(\d{1,2})$/.exec(String(s).trim());
  return m ? (Number(m[1]) * 60 + Number(m[2])) * 75 + Number(m[3]) : -1;
}

function tgCueArgs(s) {
  const out = [];
  const re = /"((?:[^"\\]|\\.)*)"|(\S+)/g;
  let m;
  while ((m = re.exec(s))) out.push(m[1] !== undefined ? m[1].replace(/\\(["\\])/g, "$1") : m[2]);
  return out;
}

function tgCue(text) {
  const cue = { title: "", performer: "", songwriter: "", catalog: "", genre: "", date: "", comment: "", files: [], tracks: [] };
  let file = null, tr = null;
  for (const raw of String(text || "").replace(/^﻿/, "").split(/\r\n|\r|\n/)) {
    const line = raw.trim();
    if (!line) continue;
    const a = tgCueArgs(line), cmd = (a[0] || "").toUpperCase();
    if (cmd === "FILE") { file = a[1] || ""; cue.files.push(file); tr = null; continue; }
    if (cmd === "TRACK") { tr = { n: Number(a[1]) || cue.tracks.length + 1, type: (a[2] || "").toUpperCase(), file, title: "", performer: "", songwriter: "", isrc: "", idx: {} }; cue.tracks.push(tr); continue; }
    if (cmd === "INDEX" && tr) { const f = tgCueTime(a[2] || ""); if (f >= 0) tr.idx[Number(a[1]) || 0] = f; continue; }
    const tgt = tr || cue;
    if (cmd === "TITLE") tgt.title = a[1] || "";
    else if (cmd === "PERFORMER") tgt.performer = a[1] || "";
    else if (cmd === "SONGWRITER") tgt.songwriter = a[1] || "";
    else if (cmd === "ISRC" && tr) tr.isrc = a[1] || "";
    else if (cmd === "CATALOG" && !tr) cue.catalog = a[1] || "";
    else if (cmd === "REM" && !tr) {
      const k = (a[1] || "").toUpperCase(), v = a.slice(2).join(" ");
      if (k === "GENRE") cue.genre = v;
      else if (k === "DATE") cue.date = v;
      else if (k === "COMMENT") cue.comment = v;
    }
  }
  for (const t of cue.tracks) t.start = t.idx[1] !== undefined ? t.idx[1] : t.idx[0] !== undefined ? t.idx[0] : -1;
  cue.tracks = cue.tracks.filter(t => t.start >= 0 && (!t.type || t.type === "AUDIO"));
  return cue;
}

function tgCueRanges(cue, sr, F, file) {
  const pick = file || cue.files[0];
  const tr = cue.tracks.filter(t => !t.file || cue.files.length < 2 || t.file === pick).map(t => Object.assign({}, t, { a: Math.round(t.start * sr / 75) })).filter(t => t.a < F).sort((p, q) => p.a - q.a);
  return tr.map((t, i) => {
    const pos = String(t.n).padStart(2, "0"), b = i + 1 < tr.length ? tr[i + 1].a : F, name = [pos, t.title].filter(Boolean).join(" ");
    const tag = {};
    for (const [k, v] of [["name", name], ["pos", pos], ["title", t.title], ["artist", t.performer || cue.performer], ["album", cue.title], ["albumArtist", cue.performer], ["year", cue.date], ["genre", cue.genre], ["isrc", t.isrc]]) if (v) tag[k] = v;
    return { a: t.a, b, name, tag };
  }).filter(r => r.b > r.a);
}

function tgCueQ(s) {
  return '"' + String(s || "").replace(/["\r\n]/g, m => m === '"' ? "'" : " ").trim() + '"';
}

function tgCueStamp(sec) {
  const f = Math.max(0, Math.floor(sec * 75 + 1e-6)), mm = Math.floor(f / 4500), ss = Math.floor(f / 75) % 60, ff = f % 75;
  return String(mm).padStart(2, "0") + ":" + String(ss).padStart(2, "0") + ":" + String(ff).padStart(2, "0");
}

function tgCueText(o) {
  const L = [];
  if (o.genre) L.push("REM GENRE " + tgCueQ(o.genre));
  if (o.date) L.push("REM DATE " + String(o.date).replace(/\s+/g, " ").trim());
  L.push("REM COMMENT " + tgCueQ(o.comment || "Delicate Studio"));
  if (o.catalog && /^\d{13}$/.test(o.catalog)) L.push("CATALOG " + o.catalog);
  if (o.performer) L.push("PERFORMER " + tgCueQ(o.performer));
  if (o.title) L.push("TITLE " + tgCueQ(o.title));
  let n = 0;
  for (const f of o.files || []) {
    L.push("FILE " + tgCueQ(f.name) + " " + (f.type || "WAVE"));
    for (const t of f.tracks || []) {
      if (++n > 99) break;
      L.push("  TRACK " + String(n).padStart(2, "0") + " AUDIO");
      if (t.title) L.push("    TITLE " + tgCueQ(t.title));
      if (t.performer) L.push("    PERFORMER " + tgCueQ(t.performer));
      if (t.isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(t.isrc)) L.push("    ISRC " + t.isrc);
      L.push("    INDEX 01 " + tgCueStamp(t.at || 0));
    }
  }
  return L.join("\r\n") + "\r\n";
}

function tgChunk(id, body) {
  const out = new Uint8Array(8 + body.length + (body.length & 1)), dv = new DataView(out.buffer);
  for (let i = 0; i < 4; i++) out[i] = id.charCodeAt(i);
  dv.setUint32(4, body.length, true);
  out.set(body, 8);
  return out;
}

function tgCat(parts) {
  const out = new Uint8Array(parts.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

function tgZ(s, n) {
  const e = new TextEncoder().encode(String(s || ""));
  const out = new Uint8Array(n ? n : e.length + 1);
  out.set(n ? e.subarray(0, n - 1) : e);
  return out;
}

function tgWavInfo(tags) {
  const got = {}, enc = new TextEncoder();
  for (const [k, v] of tags || []) { const id = TG_INFO_OUT[k]; if (id) got[id] = got[id] ? got[id] + "; " + v : v; }
  if (!Object.keys(got).length) return new Uint8Array(0);
  got.ISFT = "Delicate Studio";
  const subs = Object.entries(got).map(([id, v]) => tgChunk(id, tgCat([enc.encode(v), new Uint8Array(1)])));
  return tgChunk("LIST", tgCat([enc.encode("INFO")].concat(subs)));
}

function tgWavCue(marks) {
  const list = (marks || []).filter(m => Number.isFinite(m.a) && m.a >= 0 && m.a < 4294967296).slice(0, 999);
  if (!list.length) return new Uint8Array(0);
  const cue = new Uint8Array(4 + list.length * 24), dv = new DataView(cue.buffer);
  dv.setUint32(0, list.length, true);
  const enc = new TextEncoder(), adtl = [enc.encode("adtl")];
  list.forEach((m, i) => {
    const o = 4 + i * 24, id = i + 1;
    dv.setUint32(o, id, true);
    dv.setUint32(o + 4, m.a, true);
    for (let j = 0; j < 4; j++) cue[o + 8 + j] = "data".charCodeAt(j);
    dv.setUint32(o + 20, m.a, true);
    if (m.name) adtl.push(tgChunk("labl", tgCat([new Uint8Array([id & 255, (id >> 8) & 255, 0, 0]), tgZ(m.name)])));
    if (m.b > m.a) {
      const lt = new Uint8Array(20), lv = new DataView(lt.buffer);
      lv.setUint32(0, id, true);
      lv.setUint32(4, Math.min(4294967295, m.b - m.a), true);
      for (let j = 0; j < 4; j++) lt[8 + j] = "rgn ".charCodeAt(j);
      adtl.push(tgChunk("ltxt", lt));
    }
  });
  return tgCat([tgChunk("cue ", cue), adtl.length > 1 ? tgChunk("LIST", tgCat(adtl)) : new Uint8Array(0)]);
}

function tgBext(o) {
  const d = o.date instanceof Date ? o.date : new Date();
  const p2 = n => String(n).padStart(2, "0");
  const hist = new TextEncoder().encode(String(o.history || ""));
  const b = new Uint8Array(602 + hist.length), dv = new DataView(b.buffer);
  b.set(tgZ(o.description, 256), 0);
  b.set(tgZ(o.originator || "Delicate Studio", 32), 256);
  b.set(tgZ(o.reference || "", 32), 288);
  b.set(new TextEncoder().encode(d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate())), 320);
  b.set(new TextEncoder().encode(p2(d.getHours()) + ":" + p2(d.getMinutes()) + ":" + p2(d.getSeconds())), 330);
  const ref = Math.max(0, Math.floor(o.ref || 0));
  dv.setUint32(338, ref % 4294967296, true);
  dv.setUint32(342, Math.floor(ref / 4294967296), true);
  dv.setUint16(346, 1, true);
  b.set(hist, 602);
  return tgChunk("bext", b);
}

function tgFlacCue(tracks, total) {
  const list = (tracks || []).filter(t => Number.isFinite(t.a) && t.a >= 0 && t.a < total).sort((x, y) => x.a - y.a).slice(0, 99);
  if (!list.length) return null;
  const b = new Uint8Array(396 + list.length * 48 + 36), dv = new DataView(b.buffer);
  const u64 = (o, v) => { dv.setUint32(o, Math.floor(v / 4294967296)); dv.setUint32(o + 4, v % 4294967296); };
  b[395] = list.length + 1;
  let o = 396;
  list.forEach((t, i) => {
    u64(o, Math.floor(t.a));
    b[o + 8] = i + 1;
    if (t.isrc && /^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(t.isrc)) b.set(new TextEncoder().encode(t.isrc), o + 9);
    b[o + 35] = 1;
    o += 36;
    b[o + 8] = 1;
    o += 12;
  });
  u64(o, Math.floor(total));
  b[o + 8] = 255;
  return b;
}

if (typeof module !== "undefined") module.exports = { TG_INFO, TG_DROP, tgClean, tgGet, tgAll, tgMarks, tgRiff, tgFlac, tgCue, tgCueRanges, tgCueText, tgCueStamp, tgWavInfo, tgWavCue, tgBext, tgFlacCue, tgChunk, tgCat };

use serde::Serialize;

pub const SECTOR: usize = 2352;
pub const C2: usize = 294;
pub const Q: usize = 16;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Track {
    pub number: u8,
    pub lba: u32,
    pub data: bool,
    pub session: u8,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Toc {
    pub tracks: Vec<Track>,
    pub leadout: u32,
    pub first_leadout: u32,
}

impl Toc {
    pub fn end_of(&self, i: usize) -> u32 {
        let t = &self.tracks[i];
        match self.tracks.get(i + 1) {
            Some(n) if n.session == t.session && !n.data => n.lba,
            Some(n) if n.session == t.session => n.lba.saturating_sub(11400),
            _ => if t.session == 1 { self.first_leadout } else { self.leadout },
        }
    }
}

pub struct Read {
    pub audio: Vec<u8>,
    pub c2: Option<Vec<u8>>,
    pub q: Option<Vec<[u8; Q]>>,
}

pub trait Drive: Send {
    fn name(&self) -> String;
    fn toc(&mut self) -> Result<Toc, String>;
    fn read(&mut self, lba: u32, n: u32, c2: bool, q: bool) -> Result<Read, String>;
    fn isrc(&mut self, _track: u8) -> Option<String> { None }
    fn mcn(&mut self) -> Option<String> { None }
    fn cdtext(&mut self) -> Option<Vec<u8>> { None }
}

pub fn bcd(v: u8) -> u8 { (v >> 4) * 10 + (v & 15) }

pub fn q_index(q: &[u8; Q]) -> Option<(u8, u8)> {
    if q[0] & 15 != 1 { return None; }
    Some((bcd(q[1]), bcd(q[2])))
}

pub fn parse_toc(b: &[u8]) -> Result<Toc, String> {
    if b.len() < 4 { return Err("toc".into()); }
    let len = (u16::from_be_bytes([b[0], b[1]]) as usize + 2).min(b.len());
    let lba = |m: u8, s: u8, f: u8| ((m as i64 * 60 + s as i64) * 75 + f as i64 - 150).max(0) as u32;
    let mut tracks = Vec::new();
    let mut leadouts: Vec<(u8, u32)> = Vec::new();
    let mut o = 4;
    while o + 11 <= len {
        let d = &b[o..o + 11];
        let (session, adr, control, point) = (d[0], d[1] >> 4, d[1] & 15, d[3]);
        if adr == 1 {
            if (1..=99).contains(&point) { tracks.push(Track { number: point, lba: lba(d[8], d[9], d[10]), data: control & 4 != 0, session }); }
            if point == 0xA2 { leadouts.push((session, lba(d[8], d[9], d[10]))); }
        }
        o += 11;
    }
    if tracks.is_empty() || leadouts.is_empty() { return Err("toc".into()); }
    tracks.sort_by_key(|t| t.number);
    leadouts.sort();
    let first = leadouts.iter().find(|l| l.0 == 1).map(|l| l.1).unwrap_or(leadouts[0].1);
    Ok(Toc { tracks, leadout: leadouts.last().unwrap().1, first_leadout: first })
}

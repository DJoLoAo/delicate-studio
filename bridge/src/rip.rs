use crate::drive::{C2, Drive, SECTOR, q_index};
use serde::Serialize;

pub struct Opts {
    pub window: u32,
    pub chunk: u32,
    pub retries: u32,
}

impl Default for Opts {
    fn default() -> Opts { Opts { window: 3000, chunk: 26, retries: 16 } }
}

#[derive(Serialize, Default, Debug)]
pub struct Report {
    pub rereads: u32,
    pub fixed: Vec<u32>,
    pub suspect: Vec<u32>,
    pub c2: bool,
}

pub struct Caps {
    pub c2: bool,
    pub q: bool,
}

pub fn caps(d: &mut dyn Drive, lba: u32) -> Caps {
    Caps { c2: d.read(lba, 1, true, false).is_ok(), q: d.read(lba, 1, false, true).is_ok() }
}

fn has_c2(f: &[u8]) -> bool { f.iter().any(|b| *b != 0) }

fn pass(d: &mut dyn Drive, from: u32, n: u32, o: &Opts, c2: bool) -> (Vec<u8>, Vec<bool>) {
    let mut audio = Vec::with_capacity(n as usize * SECTOR);
    let mut bad = Vec::with_capacity(n as usize);
    let mut at = from;
    while at < from + n {
        let k = o.chunk.min(from + n - at);
        match d.read(at, k, c2, false) {
            Ok(r) => {
                audio.extend_from_slice(&r.audio);
                for i in 0..k as usize { bad.push(r.c2.as_ref().map(|f| has_c2(&f[i * C2..(i + 1) * C2])).unwrap_or(false)); }
            }
            Err(_) => {
                for s in at..at + k {
                    match d.read(s, 1, c2, false) {
                        Ok(r) => { audio.extend_from_slice(&r.audio); bad.push(r.c2.as_ref().map(|f| has_c2(f)).unwrap_or(false)); }
                        Err(_) => { audio.extend_from_slice(&[0u8; SECTOR]); bad.push(true); }
                    }
                }
            }
        }
        at += k;
    }
    (audio, bad)
}

fn defeat(d: &mut dyn Drive, lba: u32, first: u32, last: u32, o: &Opts) {
    let span = o.window.max(o.chunk * 4);
    let far = if lba >= first + span { lba - span } else if lba + span + o.chunk < last { lba + span } else { first };
    let _ = d.read(far, o.chunk.min(last.saturating_sub(far)).max(1), false, false);
}

fn resolve(d: &mut dyn Drive, lba: u32, seeds: Vec<(Vec<u8>, bool)>, first: u32, last: u32, o: &Opts, c2: bool, rep: &mut Report) -> Vec<u8> {
    let mut seen: Vec<(Vec<u8>, u32)> = Vec::new();
    let add = |seen: &mut Vec<(Vec<u8>, u32)>, s: Vec<u8>| {
        if let Some(x) = seen.iter_mut().find(|x| x.0 == s) { x.1 += 1; } else { seen.push((s, 1)); }
    };
    for (s, bad) in seeds { if !bad { add(&mut seen, s); } }
    for _ in 0..o.retries {
        if let Some(x) = seen.iter().find(|x| x.1 >= 2) { rep.fixed.push(lba); return x.0.clone(); }
        defeat(d, lba, first, last, o);
        rep.rereads += 1;
        if let Ok(r) = d.read(lba, 1, c2, false) {
            if !r.c2.as_ref().map(|f| has_c2(f)).unwrap_or(false) { add(&mut seen, r.audio); }
        }
    }
    if let Some(x) = seen.iter().find(|x| x.1 >= 2) { rep.fixed.push(lba); return x.0.clone(); }
    rep.suspect.push(lba);
    seen.sort_by(|a, b| b.1.cmp(&a.1));
    seen.into_iter().next().map(|x| x.0).unwrap_or_else(|| vec![0u8; SECTOR])
}

pub fn rip(d: &mut dyn Drive, from: u32, to: u32, disc_end: u32, o: &Opts, c2: bool, out: &mut dyn FnMut(u32, &[u8]) -> bool) -> Report {
    let mut rep = Report { c2, ..Default::default() };
    let mut w = from;
    while w < to {
        let n = o.window.min(to - w);
        let (a, fa) = pass(d, w, n, o, c2);
        let (b, fb) = pass(d, w, n, o, c2);
        let mut data = a;
        for i in 0..n as usize {
            let (x, y) = (&data[i * SECTOR..(i + 1) * SECTOR], &b[i * SECTOR..(i + 1) * SECTOR]);
            if x == y && !fa[i] && !fb[i] { continue; }
            let seeds = vec![(x.to_vec(), fa[i]), (y.to_vec(), fb[i])];
            let good = resolve(d, w + i as u32, seeds, 0, disc_end, o, c2, &mut rep);
            data[i * SECTOR..(i + 1) * SECTOR].copy_from_slice(&good);
        }
        if !out(w, &data) { break; }
        w += n;
    }
    rep
}

fn q_at(d: &mut dyn Drive, lba: u32) -> Option<(u8, u8)> {
    for _ in 0..4 {
        if let Ok(r) = d.read(lba, 1, false, true) {
            if let Some(q) = r.q.as_ref().and_then(|v| v.first()) { if let Some(x) = q_index(q) { return Some(x); } }
        }
    }
    None
}

pub fn index0(d: &mut dyn Drive, track: u8, prev: u32, start: u32) -> Option<u32> {
    if start == 0 || start <= prev + 1 { return None; }
    let (t, i) = q_at(d, start - 1)?;
    if t != track || i != 0 { return None; }
    let (mut lo, mut hi) = (prev + 1, start - 1);
    while lo < hi {
        let mid = lo + (hi - lo) / 2;
        match q_at(d, mid) {
            Some((t, 0)) if t == track => hi = mid,
            _ => lo = mid + 1,
        }
    }
    Some(lo)
}

pub fn peak(audio: &[u8]) -> i32 {
    audio.chunks(2).map(|c| (i16::from_le_bytes([c[0], c[1]]) as i32).abs()).max().unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sim::{SimDrive, Spec};

    fn disc(sectors: u32) -> Vec<u8> {
        let mut v = Vec::with_capacity(sectors as usize * SECTOR);
        let mut x: u32 = 12345;
        for _ in 0..sectors as usize * SECTOR { x = x.wrapping_mul(1103515245).wrapping_add(12345); v.push((x >> 16) as u8); }
        v
    }

    fn run(spec: Spec, n: u32) -> (Vec<u8>, Vec<u8>, Report) {
        let raw = disc(n);
        let mut d = SimDrive::new(spec, raw.clone());
        let mut got = Vec::new();
        let c2 = d.spec.c2;
        let rep = rip(&mut d, 0, n, n, &Opts { window: 200, chunk: 26, retries: 16 }, c2, &mut |_, b| { got.extend_from_slice(b); true });
        (raw, got, rep)
    }

    #[test]
    fn clean() {
        let (raw, got, rep) = run(Spec { starts: vec![0], leadout: 1000, ..Default::default() }, 1000);
        assert!(raw == got);
        assert_eq!(rep.rereads, 0);
        assert!(rep.suspect.is_empty());
    }

    #[test]
    fn flaky_sectors_are_reread() {
        let (raw, got, rep) = run(Spec { starts: vec![0], leadout: 1000, flaky: vec![5, 333, 777], ..Default::default() }, 1000);
        assert!(raw == got);
        assert_eq!(rep.fixed, vec![5, 333, 777]);
        assert!(rep.suspect.is_empty());
    }

    #[test]
    fn c2_catches_errors_that_repeat() {
        let (raw, got, rep) = run(Spec { starts: vec![0], leadout: 600, flaky: vec![100], c2: true, ..Default::default() }, 600);
        assert!(raw == got);
        assert!(rep.c2 && rep.fixed == vec![100]);
    }

    #[test]
    fn bad_sectors_are_suspect() {
        let (raw, got, rep) = run(Spec { starts: vec![0], leadout: 600, bad: vec![300], ..Default::default() }, 600);
        assert_eq!(rep.suspect, vec![300]);
        assert!(raw[..300 * SECTOR] == got[..300 * SECTOR] && raw[301 * SECTOR..] == got[301 * SECTOR..]);
    }

    #[test]
    fn pregaps_from_subchannel() {
        let spec = Spec { starts: vec![0, 500, 900], index0: vec![0, 350, 0], leadout: 1200, q: true, ..Default::default() };
        let mut d = SimDrive::new(spec, disc(1200));
        assert_eq!(index0(&mut d, 2, 0, 500), Some(350));
        assert_eq!(index0(&mut d, 3, 500, 900), None);
        let spec = Spec { starts: vec![300, 800], leadout: 1000, q: true, ..Default::default() };
        let mut d = SimDrive::new(spec, disc(1000));
        assert!(caps(&mut d, 0).q && !caps(&mut d, 0).c2);
        assert_eq!(q_at(&mut d, 10), Some((1, 0)));
    }

    #[test]
    fn toc_bytes() {
        let mut b = vec![0u8, 0, 1, 1];
        let desc = |pt: u8, m: u8, s: u8, f: u8, ctl: u8| vec![1u8, 0x10 | ctl, 0, pt, 0, 0, 0, 0, m, s, f];
        b.extend(desc(0xA0, 1, 0, 0, 0));
        b.extend(desc(0xA1, 2, 0, 0, 0));
        b.extend(desc(0xA2, 10, 0, 0, 0));
        b.extend(desc(1, 0, 2, 0, 0));
        b.extend(desc(2, 4, 30, 5, 4));
        let l = (b.len() - 2) as u16;
        b[0..2].copy_from_slice(&l.to_be_bytes());
        let t = crate::drive::parse_toc(&b).unwrap();
        assert_eq!(t.tracks.len(), 2);
        assert_eq!(t.tracks[0].lba, 0);
        assert_eq!(t.tracks[1].lba, (4 * 60 + 30) * 75 + 5 - 150);
        assert!(t.tracks[1].data && !t.tracks[0].data);
        assert_eq!(t.leadout, 10 * 60 * 75 - 150);
    }
}

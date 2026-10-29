use crate::drive::{C2, Drive, Q, Read, SECTOR, Toc, Track};
use serde::Deserialize;
use std::collections::HashMap;

#[derive(Deserialize, Default)]
pub struct Spec {
    pub starts: Vec<u32>,
    pub leadout: u32,
    #[serde(default)]
    pub index0: Vec<u32>,
    #[serde(default)]
    pub isrc: Vec<String>,
    #[serde(default)]
    pub mcn: String,
    #[serde(default)]
    pub cdtext: String,
    #[serde(default)]
    pub flaky: Vec<u32>,
    #[serde(default)]
    pub bad: Vec<u32>,
    #[serde(default)]
    pub c2: bool,
    #[serde(default)]
    pub q: bool,
    #[serde(default)]
    pub model: String,
    #[serde(default)]
    pub slow: u64,
}

pub struct SimDrive {
    pub spec: Spec,
    pub disc: Vec<u8>,
    seen: HashMap<u32, u32>,
    seed: u64,
    pub reads: u64,
}

impl SimDrive {
    pub fn new(spec: Spec, disc: Vec<u8>) -> SimDrive {
        SimDrive { spec, disc, seen: HashMap::new(), seed: 0x9e3779b97f4a7c15, reads: 0 }
    }

    pub fn open(dir: &str) -> Result<SimDrive, String> {
        let spec: Spec = serde_json::from_slice(&std::fs::read(format!("{}/spec.json", dir)).map_err(|e| e.to_string())?).map_err(|e| e.to_string())?;
        let disc = std::fs::read(format!("{}/disc.raw", dir)).map_err(|e| e.to_string())?;
        Ok(SimDrive::new(spec, disc))
    }

    fn rnd(&mut self) -> u8 {
        self.seed ^= self.seed << 13;
        self.seed ^= self.seed >> 7;
        self.seed ^= self.seed << 17;
        (self.seed >> 24) as u8
    }

    fn sector(&mut self, lba: u32) -> (Vec<u8>, bool) {
        let at = lba as usize * SECTOR;
        let mut s = if at + SECTOR <= self.disc.len() { self.disc[at..at + SECTOR].to_vec() } else { vec![0; SECTOR] };
        let n = self.seen.entry(lba).or_insert(0);
        *n += 1;
        let hits = *n;
        let broken = self.spec.bad.contains(&lba) || (self.spec.flaky.contains(&lba) && hits <= 2);
        if broken {
            for i in 0..8 { let k = (self.rnd() as usize * 7 + i * 263) % SECTOR; s[k] ^= self.rnd() | 1; }
        }
        (s, broken)
    }

    fn q(&self, lba: u32) -> [u8; Q] {
        let to_bcd = |v: u32| (((v / 10) << 4) | (v % 10)) as u8;
        let mut track = 1u32;
        for (i, s) in self.spec.starts.iter().enumerate() { if lba >= *s { track = i as u32 + 1; } }
        let mut index = 1u32;
        if let Some(next) = self.spec.starts.get(track as usize) {
            if let Some(i0) = self.spec.index0.get(track as usize) { if *i0 > 0 && lba >= *i0 && lba < *next { track += 1; index = 0; } }
        }
        if lba < self.spec.starts[0] { track = 1; index = 0; }
        let mut q = [0u8; Q];
        q[0] = 0x01;
        q[1] = to_bcd(track);
        q[2] = to_bcd(index);
        q
    }
}

impl Drive for SimDrive {
    fn name(&self) -> String { if self.spec.model.is_empty() { "SIM - DRIVE".into() } else { self.spec.model.clone() } }

    fn toc(&mut self) -> Result<Toc, String> {
        let tracks = self.spec.starts.iter().enumerate().map(|(i, s)| Track { number: i as u8 + 1, lba: *s, data: false, session: 1 }).collect();
        Ok(Toc { tracks, leadout: self.spec.leadout, first_leadout: self.spec.leadout })
    }

    fn read(&mut self, lba: u32, n: u32, c2: bool, q: bool) -> Result<Read, String> {
        if c2 && !self.spec.c2 { return Err("c2 unsupported".into()); }
        if q && !self.spec.q { return Err("q unsupported".into()); }
        if lba + n > self.spec.leadout { return Err("beyond the lead-out".into()); }
        self.reads += 1;
        if self.spec.slow > 0 { std::thread::sleep(std::time::Duration::from_millis(self.spec.slow)); }
        let mut audio = Vec::with_capacity(n as usize * SECTOR);
        let mut errs = if c2 { Some(Vec::with_capacity(n as usize * C2)) } else { None };
        let mut subq = if q { Some(Vec::with_capacity(n as usize)) } else { None };
        for k in lba..lba + n {
            let (s, broken) = self.sector(k);
            audio.extend_from_slice(&s);
            if let Some(e) = errs.as_mut() { let mut f = vec![0u8; C2]; if broken { f[3] = 0xff; } e.extend_from_slice(&f); }
            if let Some(v) = subq.as_mut() { v.push(self.q(k)); }
        }
        Ok(Read { audio, c2: errs, q: subq })
    }

    fn isrc(&mut self, track: u8) -> Option<String> { self.spec.isrc.get(track as usize - 1).filter(|s| !s.is_empty()).cloned() }
    fn mcn(&mut self) -> Option<String> { if self.spec.mcn.is_empty() { None } else { Some(self.spec.mcn.clone()) } }
    fn cdtext(&mut self) -> Option<Vec<u8>> {
        let h = &self.spec.cdtext;
        if h.is_empty() || h.len() % 2 != 0 { return None; }
        (0..h.len()).step_by(2).map(|i| u8::from_str_radix(&h[i..i + 2], 16).ok()).collect()
    }
}

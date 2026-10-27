use crate::loud::{Interp, Meter, factor, lufs};

const CLIP: f32 = 0.9999;
const CLIP_RUN: usize = 3;

pub struct Report {
    ch: usize,
    sr: usize,
    m: Meter,
    ip: Interp,
    t: usize,
    tp: Vec<f32>,
    tp_at: Vec<usize>,
    sp: Vec<f32>,
    sp_at: Vec<usize>,
    sq: Vec<f64>,
    sum: Vec<f64>,
    run: Vec<usize>,
    clips: Vec<usize>,
    overs: Vec<usize>,
    grid: Vec<i64>,
    fine: Vec<bool>,
    pub stage: Vec<f32>,
    pub out: Vec<f64>,
}

impl Report {
    pub fn new(ch: usize, sr: usize) -> Report {
        Report {
            ch,
            sr,
            m: Meter::new(ch, sr),
            ip: Interp::new(ch, factor(sr), 16),
            t: 0,
            tp: vec![0.0; ch],
            tp_at: vec![0; ch],
            sp: vec![0.0; ch],
            sp_at: vec![0; ch],
            sq: vec![0.0; ch],
            sum: vec![0.0; ch],
            run: vec![0; ch],
            clips: vec![0; ch],
            overs: vec![0; ch],
            grid: vec![0; ch],
            fine: vec![false; ch],
            stage: Vec::new(),
            out: Vec::new(),
        }
    }

    pub fn feed(&mut self, x: &[f32], m: usize) {
        self.m.feed(x, m);
        let d = self.ip.delay();
        for i in 0..m {
            for c in 0..self.ch {
                let v = x[c * m + i];
                let a = v.abs();
                if a > self.sp[c] {
                    self.sp[c] = a;
                    self.sp_at[c] = self.t;
                }
                let p = self.ip.push_above(c, v, self.tp[c]);
                if p > self.tp[c] {
                    self.tp[c] = p;
                    self.tp_at[c] = self.t.saturating_sub(d);
                }
                self.sq[c] += (v as f64) * (v as f64);
                self.sum[c] += v as f64;
                if a > 1.0 {
                    self.overs[c] += 1;
                }
                if a >= CLIP {
                    self.run[c] += 1;
                    if self.run[c] == CLIP_RUN {
                        self.clips[c] += 1;
                    }
                } else {
                    self.run[c] = 0;
                }
                if !self.fine[c] && v.is_finite() {
                    let q = v as f64 * 8388608.0;
                    if q != q.round() {
                        self.fine[c] = true;
                    } else {
                        self.grid[c] |= q as i64;
                    }
                }
            }
            self.ip.step();
            self.t += 1;
        }
    }

    pub fn feed_staged(&mut self, m: usize) {
        let x = std::mem::take(&mut self.stage);
        self.feed(&x, m);
        self.stage = x;
    }

    fn bits(&self, c: usize) -> f64 {
        if self.fine[c] {
            return 32.0;
        }
        let g = self.grid[c];
        if g == 0 { 0.0 } else { 24.0 - g.trailing_zeros().min(24) as f64 }
    }

    pub fn finish(&mut self) -> &[f64] {
        let s = self.m.stats();
        let b = &self.m.blocks;
        let arg = |w: usize| -> (f64, f64) {
            if b.len() < w {
                return (f64::NEG_INFINITY, 0.0);
            }
            let mut acc: f64 = b[..w].iter().sum();
            let (mut best, mut at) = (acc, 0usize);
            for j in w..b.len() {
                acc += b[j] - b[j - w];
                if acc > best {
                    best = acc;
                    at = j + 1 - w;
                }
            }
            (lufs(best / w as f64), at as f64 * 0.1)
        };
        let (_, m_at) = arg(4);
        let (_, st_at) = arg(30);
        let curve: Vec<f64> = if b.len() >= 30 {
            (0..=(b.len() - 30) / 10)
                .map(|k| {
                    let j = k * 10;
                    let e = b[j..j + 30].iter().sum::<f64>() / 30.0;
                    let l = lufs(e);
                    if l.is_finite() { l } else { -200.0 }
                })
                .collect()
        } else {
            Vec::new()
        };
        let n = self.t.max(1) as f64;
        let sr = self.sr as f64;
        let mut o = vec![s.integrated, s.lra, s.st_max, st_at, s.m_max, m_at, self.t as f64 / sr, curve.len() as f64, self.ch as f64];
        for c in 0..self.ch {
            o.extend_from_slice(&[
                self.tp[c] as f64,
                self.tp_at[c] as f64 / sr,
                self.sp[c] as f64,
                self.sp_at[c] as f64 / sr,
                (self.sq[c] / n).sqrt(),
                self.sum[c] / n,
                self.clips[c] as f64,
                self.overs[c] as f64,
                self.bits(c),
            ]);
        }
        o.extend(curve);
        self.out = o;
        &self.out
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn sine(n: usize, f: f64, sr: f64, a: f64) -> Vec<f32> {
        (0..n).map(|i| (a * (TAU * f * i as f64 / sr).sin()) as f32).collect()
    }

    fn run(chs: &[Vec<f32>], sr: usize) -> Vec<f64> {
        let ch = chs.len();
        let n = chs[0].len();
        let mut r = Report::new(ch, sr);
        let blk = 4096;
        let mut buf = vec![0.0f32; ch * blk];
        let mut p = 0;
        while p < n {
            let k = blk.min(n - p);
            for c in 0..ch {
                buf[c * k..c * k + k].copy_from_slice(&chs[c][p..p + k]);
            }
            r.feed(&buf[..ch * k], k);
            p += k;
        }
        r.finish().to_vec()
    }

    #[test]
    fn a_sine_reads_its_level_and_place() {
        let sr = 48000;
        let mut x = sine(sr * 10, 997.0, sr as f64, 0.1);
        x[sr * 6] = 0.5;
        let o = run(&[x.clone(), x], sr);
        assert!((o[0] + 20.0).abs() < 0.1, "{}", o[0]);
        assert!(o[1] < 0.5);
        assert_eq!(o[7] as usize, 8);
        assert_eq!(o[8] as usize, 2);
        let c = &o[9..18];
        assert!((c[2] - 0.5).abs() < 1e-6 && (c[3] - 6.0).abs() < 1e-6);
        assert!((c[1] - 6.0).abs() < 0.001, "{}", c[1]);
        assert!((c[4] - 0.1 / 2f64.sqrt()).abs() < 0.002, "{}", c[4]);
        assert!(c[5].abs() < 1e-4);
        assert_eq!(c[6] as usize, 0);
        assert_eq!(c[8], 32.0);
        for v in &o[27..] {
            assert!((v + 20.0).abs() < 0.2, "{v}");
        }
    }

    #[test]
    fn clips_dc_and_bit_depth() {
        let sr = 44100;
        let mut x: Vec<f32> = sine(sr * 4, 440.0, sr as f64, 0.5).iter().map(|v| (v * 32768.0).round() / 32768.0).collect();
        for k in 0..5 {
            for i in 0..10 {
                x[sr + k * 1000 + i] = 1.0;
            }
        }
        x[sr * 2] = 1.25;
        let y = vec![0.25f32; x.len()];
        let o = run(&[x, y], sr);
        let l = &o[9..18];
        let r = &o[18..27];
        assert_eq!(l[6] as usize, 5);
        assert_eq!(l[7] as usize, 1);
        assert_eq!(l[8], 16.0);
        assert!((r[5] - 0.25).abs() < 1e-9);
        assert_eq!(r[8], 3.0);
        assert_eq!(o[7] as usize, 2);
    }
}

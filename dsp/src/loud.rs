use std::collections::VecDeque;
use std::f64::consts::PI;

#[derive(Clone, Copy, Default)]
pub(crate) struct Bq {
    pub(crate) b: [f64; 3],
    pub(crate) a: [f64; 2],
    pub(crate) z: [f64; 2],
}

impl Bq {
    pub(crate) fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

pub(crate) fn kweight(sr: f64) -> (Bq, Bq) {
    let f0 = 1681.974450955533;
    let g = 3.999843853973347;
    let q = 0.7071752369554196;
    let k = (PI * f0 / sr).tan();
    let vh = 10f64.powf(g / 20.0);
    let vb = vh.powf(0.4996667741545416);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Bq { b: [(vh + vb * k / q + k * k) / a0, 2.0 * (k * k - vh) / a0, (vh - vb * k / q + k * k) / a0], a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0], z: [0.0; 2] };
    let f0 = 38.13547087602444;
    let q = 0.5003270373238773;
    let k = (PI * f0 / sr).tan();
    let a0 = 1.0 + k / q + k * k;
    let hp = Bq { b: [1.0, -2.0, 1.0], a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0], z: [0.0; 2] };
    (shelf, hp)
}

fn weights(ch: usize) -> Vec<f64> {
    if ch == 6 { vec![1.0, 1.0, 1.0, 0.0, 1.41, 1.41] } else if ch == 5 { vec![1.0, 1.0, 1.0, 1.41, 1.41] } else { vec![1.0; ch] }
}

pub fn lufs(e: f64) -> f64 {
    if e > 0.0 { -0.691 + 10.0 * e.log10() } else { f64::NEG_INFINITY }
}

pub fn factor(sr: usize) -> usize {
    if sr < 88200 { 4 } else if sr < 176400 { 2 } else { 1 }
}

pub struct Interp {
    f: usize,
    taps: usize,
    h: Vec<f32>,
    hist: Vec<Vec<f32>>,
    pos: usize,
    l1: f32,
    cold: Vec<usize>,
}

impl Interp {
    pub fn new(ch: usize, f: usize, taps: usize) -> Interp {
        let len = f * taps;
        let c = (len as f64 - 1.0) / 2.0;
        let beta = 7.0;
        let i0 = |x: f64| {
            let (mut s, mut t) = (1.0, 1.0);
            for k in 1..30 {
                t *= (x / 2.0) / k as f64;
                s += t * t;
            }
            s
        };
        let mut proto: Vec<f64> = (0..len)
            .map(|n| {
                let d = (n as f64 - c) / f as f64;
                let sinc = if d.abs() < 1e-12 { 1.0 } else { (PI * d).sin() / (PI * d) };
                let r = (n as f64 - c) / (c + 0.5);
                sinc * i0(beta * (1.0 - r * r).max(0.0).sqrt()) / i0(beta)
            })
            .collect();
        for p in 0..f {
            let s: f64 = (0..taps).map(|k| proto[k * f + p]).sum();
            if s.abs() > 1e-12 {
                for k in 0..taps {
                    proto[k * f + p] /= s;
                }
            }
        }
        let mut h = vec![0.0f32; len];
        for p in 0..f {
            for k in 0..taps {
                h[p * taps + k] = proto[k * f + p] as f32;
            }
        }
        let l1 = (0..f).map(|p| h[p * taps..(p + 1) * taps].iter().map(|v| v.abs()).sum::<f32>()).fold(1.0f32, f32::max) * 1.001;
        Interp { f, taps, h, hist: vec![vec![0.0; 2 * taps]; ch], pos: 0, l1, cold: vec![0; ch] }
    }

    pub fn delay(&self) -> usize {
        self.taps / 2
    }

    pub fn reset(&mut self) {
        for h in &mut self.hist {
            h.fill(0.0);
        }
        self.cold.fill(0);
        self.pos = 0;
    }

    pub fn push(&mut self, c: usize, x: f32) -> f32 {
        self.push_above(c, x, 0.0)
    }

    pub fn push_above(&mut self, c: usize, x: f32, floor: f32) -> f32 {
        let t = self.taps;
        let hb = &mut self.hist[c];
        hb[self.pos] = x;
        hb[self.pos + t] = x;
        let base = self.pos + 1;
        let mut m = hb[base + t - 1 - t / 2].abs();
        if self.f == 1 {
            return m;
        }
        if floor > 0.0 {
            if x.abs() * self.l1 < floor {
                self.cold[c] += 1;
            } else {
                self.cold[c] = 0;
            }
            if self.cold[c] >= t {
                return m;
            }
        }
        for p in 0..self.f {
            let hp = &self.h[p * t..(p + 1) * t];
            let mut y = 0.0f32;
            for k in 0..t {
                y += hp[k] * hb[base + t - 1 - k];
            }
            m = m.max(y.abs());
        }
        m
    }

    pub fn step(&mut self) {
        self.pos = (self.pos + 1) % self.taps;
    }
}

pub struct Stats {
    pub integrated: f64,
    pub lra: f64,
    pub st_max: f64,
    pub m_max: f64,
    pub tp: Vec<f32>,
    pub sp: Vec<f32>,
}

pub struct Meter {
    ch: usize,
    w: Vec<f64>,
    f1: Vec<Bq>,
    f2: Vec<Bq>,
    n100: usize,
    cnt: usize,
    acc: f64,
    pub blocks: Vec<f64>,
    ip: Interp,
    tp: Vec<f32>,
    sp: Vec<f32>,
    pub stage: Vec<f32>,
}

impl Meter {
    pub fn new(ch: usize, sr: usize) -> Meter {
        let (a, b) = kweight(sr as f64);
        Meter {
            ch,
            w: weights(ch),
            f1: vec![a; ch],
            f2: vec![b; ch],
            n100: (sr / 10).max(1),
            cnt: 0,
            acc: 0.0,
            blocks: Vec::new(),
            ip: Interp::new(ch, factor(sr), 16),
            tp: vec![0.0; ch],
            sp: vec![0.0; ch],
            stage: Vec::new(),
        }
    }

    pub fn feed(&mut self, x: &[f32], m: usize) {
        let ch = self.ch;
        for i in 0..m {
            let mut e = 0.0;
            for c in 0..ch {
                let v = x[c * m + i];
                let z = self.f2[c].run(self.f1[c].run(v as f64));
                e += self.w[c] * z * z;
                let a = v.abs();
                if a > self.sp[c] {
                    self.sp[c] = a;
                }
                let t = self.ip.push_above(c, v, self.tp[c]);
                if t > self.tp[c] {
                    self.tp[c] = t;
                }
            }
            self.ip.step();
            self.acc += e;
            self.cnt += 1;
            if self.cnt == self.n100 {
                self.blocks.push(self.acc / self.n100 as f64);
                self.acc = 0.0;
                self.cnt = 0;
            }
        }
    }

    pub fn feed_staged(&mut self, m: usize) {
        let x = std::mem::take(&mut self.stage);
        self.feed(&x, m);
        self.stage = x;
    }

    pub fn stats(&self) -> Stats {
        let b = &self.blocks;
        let mom: Vec<f64> = if b.len() >= 4 { (3..b.len()).map(|j| b[j - 3..=j].iter().sum::<f64>() / 4.0).collect() } else { Vec::new() };
        let st: Vec<f64> = if b.len() >= 30 { (29..b.len()).map(|j| b[j - 29..=j].iter().sum::<f64>() / 30.0).collect() } else { Vec::new() };
        let gate = |v: &[f64], rel: f64| -> (Vec<f64>, f64) {
            let abs: Vec<f64> = v.iter().copied().filter(|&e| lufs(e) > -70.0).collect();
            if abs.is_empty() {
                return (Vec::new(), f64::NEG_INFINITY);
            }
            let mean = abs.iter().sum::<f64>() / abs.len() as f64;
            let thr = lufs(mean) - rel;
            let kept: Vec<f64> = abs.into_iter().filter(|&e| lufs(e) > thr).collect();
            (kept, thr)
        };
        let (ki, _) = gate(&mom, 10.0);
        let integrated = if ki.is_empty() { f64::NEG_INFINITY } else { lufs(ki.iter().sum::<f64>() / ki.len() as f64) };
        let (ks, _) = gate(&st, 20.0);
        let lra = if ks.len() < 2 {
            0.0
        } else {
            let mut l: Vec<f64> = ks.iter().map(|&e| lufs(e)).collect();
            l.sort_by(|p, q| p.partial_cmp(q).unwrap());
            let at = |q: f64| l[((l.len() - 1) as f64 * q).round() as usize];
            at(0.95) - at(0.10)
        };
        let mx = |v: &[f64]| v.iter().copied().fold(f64::NEG_INFINITY, |a, e| a.max(lufs(e)));
        Stats { integrated, lra, st_max: mx(&st), m_max: mx(&mom), tp: self.tp.clone(), sp: self.sp.clone() }
    }
}

pub struct Limiter {
    ch: usize,
    sr: usize,
    gain: Vec<f32>,
    ceil: f32,
    look: usize,
    rel: f32,
    on: bool,
    ip: Interp,
    prev: Vec<f32>,
    rq: VecDeque<(usize, f32)>,
    env: f32,
    boxv: Vec<f32>,
    boxi: usize,
    boxs: f64,
    dly: Vec<Vec<f32>>,
    dpos: usize,
    t: usize,
    pub stage: Vec<f32>,
    pub out: Vec<f32>,
    pub gr: f32,
}

impl Limiter {
    pub fn new(ch: usize, sr: usize) -> Limiter {
        let ip = Interp::new(ch, factor(sr), 16);
        let mut l = Limiter {
            ch,
            sr,
            gain: vec![1.0; ch],
            ceil: 1.0,
            look: 1,
            rel: 0.0,
            on: true,
            ip,
            prev: vec![0.0; ch],
            rq: VecDeque::new(),
            env: 1.0,
            boxv: Vec::new(),
            boxi: 0,
            boxs: 0.0,
            dly: Vec::new(),
            dpos: 0,
            t: 0,
            stage: Vec::new(),
            out: Vec::new(),
            gr: 0.0,
        };
        l.configure(0.0, -1.0, 5.0, 25.0, true);
        l
    }

    pub fn configure(&mut self, gain_db: f64, ceil_db: f64, look_ms: f64, rel_ms: f64, on: bool) {
        let g = 10f64.powf(gain_db / 20.0) as f32;
        self.gain = vec![g; self.ch];
        self.ceil = 10f64.powf(ceil_db / 20.0) as f32 * 0.985;
        self.look = ((look_ms.clamp(0.5, 50.0) * self.sr as f64 / 1000.0).round() as usize).max(1);
        let coef = |ms: f64| (1.0 - (-1.0 / (ms * self.sr as f64 / 1000.0)).exp()) as f32;
        self.rel = coef(rel_ms.clamp(1.0, 5000.0));
        self.on = on;
        self.reset();
    }

    pub fn set_gain(&mut self, c: usize, gain_db: f64) {
        if c < self.ch {
            self.gain[c] = 10f64.powf(gain_db / 20.0) as f32;
        }
    }

    pub fn latency(&self) -> usize {
        if self.on { self.ip.delay() + self.look - 1 } else { 0 }
    }

    pub fn reset(&mut self) {
        self.ip.reset();
        self.prev = vec![0.0; self.ch];
        self.rq.clear();
        self.env = 1.0;
        self.boxv = vec![1.0; self.look];
        self.boxi = 0;
        self.boxs = self.look as f64;
        let len = self.latency() + 1;
        self.dly = vec![vec![0.0; len]; self.ch];
        self.dpos = 0;
        self.t = 0;
        self.gr = 0.0;
    }

    pub fn stage(&mut self, m: usize) -> *mut f32 {
        self.stage.resize(self.ch * m, 0.0);
        self.stage.as_mut_ptr()
    }

    pub fn run(&mut self, m: usize) -> usize {
        let ch = self.ch;
        self.out.resize(ch * m, 0.0);
        if !self.on {
            for c in 0..ch {
                let g = self.gain[c];
                for i in 0..m {
                    self.out[c * m + i] = self.stage[c * m + i] * g;
                }
            }
            return m;
        }
        let d = self.ip.delay();
        let len = self.dly[0].len();
        let lat = self.latency();
        let mut w = 0;
        for i in 0..m {
            let mut pk = 0.0f32;
            for c in 0..ch {
                let u = self.stage[c * m + i] * self.gain[c];
                let ip = self.ip.push_above(c, u, self.ceil);
                let p = ip.max(self.prev[c]);
                self.prev[c] = ip;
                pk = pk.max(p);
                self.dly[c][self.dpos] = u;
            }
            self.ip.step();
            let t = self.t;
            let s_ok = t >= d;
            let r = if s_ok && pk > self.ceil { self.ceil / pk } else { 1.0 };
            while let Some(&(_, v)) = self.rq.back() {
                if v >= r {
                    self.rq.pop_back();
                } else {
                    break;
                }
            }
            self.rq.push_back((t, r));
            while let Some(&(at, _)) = self.rq.front() {
                if at + self.look <= t {
                    self.rq.pop_front();
                } else {
                    break;
                }
            }
            let mn = self.rq.front().map(|q| q.1).unwrap_or(1.0);
            self.env = if mn < self.env { mn } else { self.env + (mn - self.env) * self.rel };
            self.boxs += self.env as f64 - self.boxv[self.boxi] as f64;
            self.boxv[self.boxi] = self.env;
            self.boxi = (self.boxi + 1) % self.look;
            let g = ((self.boxs / self.look as f64) as f32).min(1.0);
            if g < 1.0 {
                let db = -20.0 * g.log10();
                if db > self.gr {
                    self.gr = db;
                }
            }
            let rd = (self.dpos + 1) % len;
            if t >= lat {
                for c in 0..ch {
                    self.out[c * m + w] = self.dly[c][rd] * g;
                }
                w += 1;
            }
            self.dpos = rd;
            self.t += 1;
        }
        if w < m {
            for c in 1..ch {
                self.out.copy_within(c * m..c * m + w, c * w);
            }
        }
        w
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn sine(n: usize, f: f64, sr: f64, a: f64, ph: f64) -> Vec<f32> {
        (0..n).map(|i| (a * (TAU * f * i as f64 / sr + ph).sin()) as f32).collect()
    }

    fn noise(n: usize, seed: u32) -> Vec<f32> {
        let mut x = seed;
        (0..n)
            .map(|_| {
                let mut s = 0.0;
                for _ in 0..4 {
                    x ^= x << 13;
                    x ^= x >> 17;
                    x ^= x << 5;
                    s += x as f32 / u32::MAX as f32 - 0.5;
                }
                s
            })
            .collect()
    }

    #[test]
    fn stereo_sine_at_minus_23_reads_minus_23_lufs() {
        for sr in [44100usize, 48000, 96000] {
            let n = sr * 20;
            let a = 10f64.powf(-23.0 / 20.0);
            let s = sine(n, 1000.0, sr as f64, a, 0.0);
            let mut x = s.clone();
            x.extend_from_slice(&s);
            let mut m = Meter::new(2, sr);
            m.feed(&x, n);
            let st = m.stats();
            assert!((st.integrated + 23.0).abs() < 0.1, "sr {sr}: {}", st.integrated);
            assert!(st.lra < 0.2, "lra {}", st.lra);
        }
    }

    #[test]
    fn gating_ignores_silence_and_lra_sees_a_step() {
        let sr = 48000;
        let a = 10f64.powf(-20.0 / 20.0);
        let mut s = sine(sr * 20, 1000.0, sr as f64, a, 0.0);
        s.extend(std::iter::repeat_n(0.0f32, sr * 20));
        let mut m = Meter::new(1, sr);
        m.feed(&s, s.len());
        let st = m.stats();
        assert!((st.integrated - (-20.0 - 3.01)).abs() < 0.1, "{}", st.integrated);
        let mut s = sine(sr * 20, 1000.0, sr as f64, 10f64.powf(-30.0 / 20.0), 0.0);
        s.extend(sine(sr * 20, 1000.0, sr as f64, 10f64.powf(-20.0 / 20.0), 0.0));
        let mut m = Meter::new(1, sr);
        m.feed(&s, s.len());
        let st = m.stats();
        assert!((st.lra - 10.0).abs() < 0.5, "lra {}", st.lra);
    }

    #[test]
    fn true_peak_sees_inter_sample_peaks() {
        let sr = 48000;
        let n = sr;
        let s = sine(n, 12000.0, sr as f64, 0.5, PI / 4.0);
        let mut m = Meter::new(1, sr);
        m.feed(&s, n);
        let st = m.stats();
        let sp = 20.0 * (st.sp[0] as f64).log10();
        let tp = 20.0 * (st.tp[0] as f64).log10();
        assert!((sp - (-9.03)).abs() < 0.1, "sample peak {sp}");
        assert!((tp - (-6.02)).abs() < 0.25, "true peak {tp}");
        let s = sine(n, 997.0, sr as f64, 0.5, 0.3);
        let mut m = Meter::new(1, sr);
        m.feed(&s, n);
        let tp = 20.0 * (m.stats().tp[0] as f64).log10();
        assert!((tp - (-6.02)).abs() < 0.05, "true peak {tp}");
    }

    #[test]
    fn limiter_holds_the_true_peak_ceiling_and_keeps_quiet_parts() {
        let sr = 44100;
        let n = sr * 6;
        let mut x = noise(n, 9);
        for i in 0..n {
            let env = if i >= n - 2 * sr { 0.03 } else if (i / (sr / 4)) % 2 == 0 { 0.15 } else { 0.9 };
            x[i] *= env;
            if i % 9001 == 0 && i < n - 2 * sr {
                x[i] = 1.5;
            }
        }
        let y2 = noise(n, 4);
        let mut stg = x.clone();
        stg.extend(y2.iter().enumerate().map(|(i, v)| v * if i >= n - 2 * sr { 0.03 } else { 0.3 }));
        let mut l = Limiter::new(2, sr);
        l.configure(12.0, -1.0, 5.0, 150.0, true);
        let mut out = vec![0.0f32; 2 * n];
        let blk = 4096;
        let (mut o, mut w) = (0, 0);
        while w < n {
            let k = blk;
            l.stage(k);
            for c in 0..2 {
                for i in 0..k {
                    l.stage[c * k + i] = if o + i < n { stg[c * n + o + i] } else { 0.0 };
                }
            }
            let got = l.run(k);
            for c in 0..2 {
                for i in 0..got.min(n - w) {
                    out[c * n + w + i] = l.out[c * got + i];
                }
            }
            w += got;
            o += k;
        }
        let lat = 0;
        let mut m = Meter::new(2, sr);
        m.feed(&out, n);
        let st = m.stats();
        let tp = 20.0 * (st.tp.iter().copied().fold(0.0f32, f32::max) as f64).log10();
        assert!(tp <= -0.95, "output true peak {tp}");
        let g = 10f32.powf(12.0 / 20.0);
        assert!(l.gr > 6.0, "gain reduction {}", l.gr);
        let mut ratio = Vec::new();
        for i in (lat + 1000)..(n - 10) {
            let a = stg[i - lat] * g;
            if a.abs() > 1e-3 {
                ratio.push(out[i] / a);
            }
        }
        assert!(ratio.iter().all(|&r| r <= 1.0001 && r > 0.0), "gain must stay within 0..1");
        let tail: Vec<f32> = (n - sr / 2..n - 10).filter(|&i| stg[i - lat].abs() > 1e-3).map(|i| out[i] / (stg[i - lat] * g)).collect();
        let lo = tail.iter().copied().fold(f32::MAX, f32::min);
        let hi = tail.iter().copied().fold(0.0f32, f32::max);
        assert!(lo > 0.999, "quiet part recovers to unity gain {lo} {hi} {}", tail.len());
    }
}

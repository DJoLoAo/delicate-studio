use realfft::num_complex::Complex;
use realfft::RealFftPlanner;

pub const MAX_HARM: usize = 30;

pub struct Hum {
    pub ch: usize,
    sr: f64,
    co: Vec<[f64; 5]>,
    st: Vec<Vec<[f64; 2]>>,
    only: bool,
    pub inp: Vec<f32>,
    pub out: Vec<f32>,
}

fn cut(sr: f64, f: f64, q: f64, gain_db: f64) -> [f64; 5] {
    let g = 10f64.powf(gain_db / 20.0);
    let w = std::f64::consts::TAU * f / sr;
    let (sn, cs) = w.sin_cos();
    let al = sn / (2.0 * q);
    let a0 = 1.0 + al;
    [(1.0 + g * al) / a0, -2.0 * cs / a0, (1.0 - g * al) / a0, -2.0 * cs / a0, (1.0 - al) / a0]
}

impl Hum {
    pub fn new(ch: usize, sr: usize) -> Self {
        Self { ch, sr: sr as f64, co: Vec::new(), st: vec![Vec::new(); ch], only: false, inp: Vec::new(), out: Vec::new() }
    }

    pub fn configure(&mut self, f0: f64, harmonics: usize, q: f64, gain_db: f64, slope: f64, only: bool) {
        let n = harmonics.clamp(1, MAX_HARM);
        let mut co = Vec::new();
        for k in 1..=n {
            let f = f0 * k as f64;
            if f <= 0.0 || f >= self.sr * 0.45 {
                break;
            }
            let share = if n > 1 { 1.0 + slope * (k - 1) as f64 / (n - 1) as f64 } else { 1.0 };
            let g = gain_db.max(0.0) * share.max(0.0);
            if g < 0.01 {
                continue;
            }
            co.push(cut(self.sr, f, q.clamp(0.5, 500.0), -g));
        }
        if co.len() != self.co.len() {
            for s in &mut self.st {
                *s = vec![[0.0; 2]; co.len()];
            }
        }
        self.co = co;
        self.only = only;
    }

    pub fn filters(&self) -> usize {
        self.co.len()
    }

    pub fn reset(&mut self) {
        for s in &mut self.st {
            s.iter_mut().for_each(|v| *v = [0.0; 2]);
        }
    }

    pub fn stage(&mut self, m: usize) -> *mut f32 {
        if self.inp.len() < m * self.ch {
            self.inp.resize(m * self.ch, 0.0);
        }
        self.inp.as_mut_ptr()
    }

    pub fn run(&mut self, m: usize) -> usize {
        if self.out.len() < m * self.ch {
            self.out.resize(m * self.ch, 0.0);
        }
        for c in 0..self.ch {
            let st = &mut self.st[c];
            for i in 0..m {
                let x = self.inp[c * m + i] as f64;
                let mut y = x;
                for (s, k) in st.iter_mut().zip(&self.co) {
                    let o = k[0] * y + s[0];
                    s[0] = k[1] * y - k[3] * o + s[1];
                    s[1] = k[2] * y - k[4] * o;
                    y = o;
                }
                self.out[c * m + i] = if self.only { (x - y) as f32 } else { y as f32 };
            }
        }
        m
    }

    pub fn response(&self, f: f64) -> f64 {
        let w = std::f64::consts::TAU * f / self.sr;
        let z1 = Complex::new(w.cos(), -w.sin());
        let z2 = z1 * z1;
        let mut h = Complex::new(1.0, 0.0);
        for k in &self.co {
            h *= (Complex::new(k[0], 0.0) + z1 * k[1] + z2 * k[2]) / (Complex::new(1.0, 0.0) + z1 * k[3] + z2 * k[4]);
        }
        let v = if self.only { (Complex::new(1.0, 0.0) - h).norm() } else { h.norm() };
        20.0 * v.max(1e-9).log10()
    }
}

pub struct Found {
    pub f0: f64,
    pub score: f64,
    pub harmonics: usize,
    pub prom: Vec<f32>,
    pub spec: Vec<f32>,
    pub bin: f64,
}

pub fn find(x: &[f32], sr: usize, fmin: f64, fmax: f64) -> Option<Found> {
    let srf = sr as f64;
    let mut n = (srf / 0.35).log2().ceil().exp2() as usize;
    while n > x.len() && n > 16384 {
        n /= 2;
    }
    if x.len() < n || fmin <= 0.0 || fmax <= fmin {
        return None;
    }
    let pad = if (x.len() - n) / (n / 4).max(1) + 1 < 8 { 4 } else { 1 };
    let nf = n * pad;
    let bins = nf / 2 + 1;
    let binw = srf / nf as f64;
    let mut pl = RealFftPlanner::<f32>::new();
    let fft = pl.plan_fft_forward(nf);
    let win: Vec<f32> = (0..n).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32).collect();
    let mut buf = vec![0.0f32; nf];
    let mut spec = vec![Complex::new(0.0f32, 0.0); bins];
    let mut scratch = fft.make_scratch_vec();
    let hop = (n / 4).max(1);
    let segs = (x.len() - n) / hop + 1;
    let step = segs.div_ceil(96).max(1);
    let mut cols: Vec<Vec<f32>> = Vec::new();
    let mut s0 = 0usize;
    while s0 + n <= x.len() {
        for i in 0..n {
            buf[i] = x[s0 + i] * win[i];
        }
        buf[n..].iter_mut().for_each(|v| *v = 0.0);
        let _ = fft.process_with_scratch(&mut buf, &mut spec, &mut scratch);
        cols.push(spec.iter().map(|c| (c.norm_sqr() as f64 + 1e-30).ln() as f32).collect());
        s0 += hop * step;
    }
    let k = cols.len();
    let pick = (k as f64 * 0.2).floor() as usize;
    let mut tmp = vec![0.0f32; k];
    let lp: Vec<f64> = (0..bins)
        .map(|b| {
            for (j, c) in cols.iter().enumerate() {
                tmp[j] = c[b];
            }
            let (_, v, _) = tmp.select_nth_unstable_by(pick.min(k - 1), |a, b| a.total_cmp(b));
            *v as f64
        })
        .collect();
    let mut cum = vec![0.0f64; bins + 1];
    for b in 0..bins {
        cum[b + 1] = cum[b] + lp[b];
    }
    let wide = ((3.0 / binw).round() as usize).max(8 * pad);
    let at = |pos: f64| -> f64 {
        let i = pos.round() as usize;
        if i == 0 || i + 1 >= bins {
            return lp[i.min(bins - 1)];
        }
        let t = pos - i as f64;
        let (a, b, c) = (lp[i - 1], lp[i], lp[i + 1]);
        b + 0.5 * t * (c - a) + 0.5 * t * t * (a - 2.0 * b + c)
    };
    let floor = |pos: f64| -> f64 {
        let c = pos.round() as isize;
        let (mut s, mut k) = (0.0, 0.0);
        let gap = 4 * pad as isize;
        for (a, b) in [(c - wide as isize, c - gap), (c + gap + 1, c + wide as isize + 1)] {
            let (a, b) = (a.max(0) as usize, (b.max(0) as usize).min(bins));
            if b > a {
                s += cum[b] - cum[a];
                k += (b - a) as f64;
            }
        }
        if k > 0.0 { s / k } else { at(pos) }
    };
    let prom = |f: f64| -> f64 { (at(f / binw) - floor(f / binw)) * 10.0 / std::f64::consts::LN_10 };
    let mut best = (f64::NEG_INFINITY, fmin);
    let mut f0 = fmin;
    while f0 <= fmax {
        let kmax = ((srf * 0.45 / f0) as usize).min(10);
        let score: f64 = (1..=kmax).map(|k| prom(f0 * k as f64).max(0.0)).sum();
        if score > best.0 {
            best = (score, f0);
        }
        f0 += 0.005;
    }
    let f0 = best.1;
    let pr: Vec<f32> = (1..=MAX_HARM).map(|k| if f0 * k as f64 >= srf * 0.45 { 0.0 } else { prom(f0 * k as f64) as f32 }).collect();
    let mut harmonics = 0;
    let lead = (0..3).max_by(|&a, &b| pr[a].total_cmp(&pr[b])).unwrap_or(0);
    if pr[lead] >= 10.0 {
        let mut hits = 0;
        for (i, &v) in pr.iter().enumerate().take(20) {
            if v >= 6.0 {
                hits += 1;
                if hits as f64 >= 0.6 * (i + 1) as f64 {
                    harmonics = i + 1;
                }
            }
        }
        harmonics = harmonics.max(lead + 1);
    }
    let top = ((2000.0 / binw) as usize).min(bins);
    let sp: Vec<f32> = (0..top).step_by(pad).map(|b| (lp[b] * 10.0 / std::f64::consts::LN_10 - 20.0 * (n as f64 / 4.0).log10()) as f32).collect();
    Some(Found { f0, score: best.0, harmonics, prom: pr, spec: sp, bin: binw * pad as f64 })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(n: usize, seed: u64, amp: f32) -> Vec<f32> {
        let mut s = seed;
        (0..n)
            .map(|_| {
                s = s.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
                ((s >> 40) as f32 / (1u64 << 24) as f32 * 2.0 - 1.0) * amp
            })
            .collect()
    }

    fn hum(n: usize, sr: f64, f0: f64) -> Vec<f32> {
        let amps = [1.0, 0.6, 0.45, 0.2, 0.3, 0.1, 0.15, 0.05];
        (0..n)
            .map(|i| {
                let t = i as f64 / sr;
                let ph = std::f64::consts::TAU * f0 * t + 0.4 * (std::f64::consts::TAU * 0.07 * t).sin();
                amps.iter().enumerate().map(|(k, a)| a * ((k as f64 + 1.0) * ph + k as f64).sin()).sum::<f64>() as f32 * 0.004
            })
            .collect()
    }

    #[test]
    fn finds_hum_in_a_short_quiet_stretch() {
        for (sr, f0) in [(44100usize, 50.0f64), (96000, 59.97)] {
            let n = sr * 17 / 10;
            let h = hum(n, sr as f64, f0);
            let nz = noise(n, 9, 0.003);
            let x: Vec<f32> = h.iter().zip(&nz).map(|(a, b)| a + b).collect();
            let f = find(&x, sr, f0.round() - 0.8, f0.round() + 0.8).unwrap();
            assert!((f.f0 - f0).abs() < 0.05, "short stretch found {} for {}", f.f0, f0);
            assert!(f.harmonics >= 4, "harmonics {}", f.harmonics);
        }
    }

    #[test]
    fn finds_and_removes_hum() {
        for (sr, f0) in [(44100usize, 49.97f64), (96000, 60.02)] {
            let n = sr * 12;
            let h = hum(n, sr as f64, f0);
            let nz = noise(n, 3, 0.002);
            let x: Vec<f32> = h.iter().zip(&nz).map(|(a, b)| a + b).collect();
            let f = find(&x, sr, f0.round() - 0.8, f0.round() + 0.8).unwrap();
            assert!((f.f0 - f0).abs() < 0.03, "found {} for {}", f.f0, f0);
            assert!((6..=9).contains(&f.harmonics), "harmonics {}", f.harmonics);
            assert!(f.prom[0] > 20.0 && f.prom[1] > 15.0, "prominence {:?}", &f.prom[..8]);
            let mut d = Hum::new(1, sr);
            d.configure(f.f0, 8, 30.0, 40.0, 0.0, false);
            let run = |d: &mut Hum, v: &[f32]| -> Vec<f32> {
                d.reset();
                let mut out = Vec::new();
                for chunk in v.chunks(4096) {
                    let p = d.stage(chunk.len());
                    unsafe { std::slice::from_raw_parts_mut(p, chunk.len()) }.copy_from_slice(chunk);
                    let m = d.run(chunk.len());
                    out.extend_from_slice(&d.out[..m]);
                }
                out
            };
            let yh = run(&mut d, &h);
            let e = |v: &[f32]| v[sr * 2..].iter().map(|s| (*s as f64).powi(2)).sum::<f64>();
            let red = 10.0 * (e(&h) / e(&yh)).log10();
            assert!(red > 25.0, "hum lowered by {red} dB at {sr}");
            let yn = run(&mut d, &nz);
            let keep = 10.0 * (e(&nz) / e(&yn)).log10();
            assert!(keep.abs() < 0.3, "broadband level changed by {keep} dB");
            assert!(d.response(f.f0) < -35.0 && d.response(f.f0 * 1.5).abs() < 0.5, "response {} {} red {red} keep {keep}", d.response(f.f0), d.response(f.f0 * 1.5));
        }
    }
}

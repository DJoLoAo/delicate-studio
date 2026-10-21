use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::sync::Arc;

pub struct Stft {
    pub n: usize,
    pub hop: usize,
    pub bins: usize,
    win: Vec<f32>,
    norm: Vec<f32>,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    sf: Vec<Complex<f32>>,
    si: Vec<Complex<f32>>,
    t: Vec<f32>,
}

impl Stft {
    pub fn new(n: usize, k: usize) -> Self {
        let hop = (n / k.max(3)).max(1);
        let win: Vec<f32> = (0..n).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32).collect();
        let norm = (0..hop)
            .map(|i| {
                let mut s = 0.0f64;
                let mut j = i;
                while j < n {
                    s += (win[j] as f64).powi(2);
                    j += hop;
                }
                (1.0 / (s * n as f64)) as f32
            })
            .collect();
        let mut pl = RealFftPlanner::<f32>::new();
        let fwd = pl.plan_fft_forward(n);
        let inv = pl.plan_fft_inverse(n);
        let sf = fwd.make_scratch_vec();
        let si = inv.make_scratch_vec();
        Self { n, hop, bins: n / 2 + 1, win, norm, fwd, inv, sf, si, t: vec![0.0; n] }
    }

    pub fn analyze(&mut self, x: &[f32], out: &mut [Complex<f32>]) {
        for i in 0..self.n {
            self.t[i] = x[i] * self.win[i];
        }
        let _ = self.fwd.process_with_scratch(&mut self.t, out, &mut self.sf);
    }

    pub fn synth(&mut self, spec: &mut [Complex<f32>], acc: &mut [f32]) {
        spec[0].im = 0.0;
        spec[self.bins - 1].im = 0.0;
        let _ = self.inv.process_with_scratch(spec, &mut self.t, &mut self.si);
        for i in 0..self.n {
            acc[i] += self.t[i] * self.win[i];
        }
    }

    pub fn norm(&self) -> &[f32] {
        &self.norm
    }
}

pub struct Print {
    pub mean: Vec<f32>,
    pub lo: Vec<f32>,
    pub hi: Vec<f32>,
    pub frames: usize,
}

pub fn print_of(x: &[f32], n: usize, k: usize) -> Option<Print> {
    if x.len() < n {
        return None;
    }
    let mut st = Stft::new(n, k);
    let (hop, bins) = (st.hop, st.bins);
    let frames = (x.len() - n) / hop + 1;
    let mut spec = vec![Complex::new(0.0f32, 0.0); bins];
    let (mut s, mut l1, mut l2) = (vec![0f64; bins], vec![0f64; bins], vec![0f64; bins]);
    for f in 0..frames {
        st.analyze(&x[f * hop..f * hop + n], &mut spec);
        for b in 0..bins {
            let p = spec[b].norm_sqr() as f64;
            s[b] += p;
            let l = (p + 1e-30).ln();
            l1[b] += l;
            l2[b] += l * l;
        }
    }
    let fr = frames as f64;
    let mut out = Print { mean: vec![0.0; bins], lo: vec![0.0; bins], hi: vec![0.0; bins], frames };
    for b in 0..bins {
        let m = l1[b] / fr;
        let sd = (l2[b] / fr - m * m).max(0.0).sqrt();
        out.mean[b] = (s[b] / fr) as f32;
        out.lo[b] = (m - 1.2816 * sd).exp() as f32;
        out.hi[b] = (m + 1.2816 * sd).exp() as f32;
    }
    Some(out)
}

fn e1(x: f32) -> f32 {
    if x < 1.0 {
        let x = x.max(1e-12);
        -x.ln() - 0.577_215_66 + x * (0.999_991_93 + x * (-0.249_910_55 + x * (0.055_199_68 + x * (-0.009_760_04 + x * 0.001_078_57))))
    } else {
        let num = x * x + 2.334_733 * x + 0.250_621;
        let den = x * x + 3.330_657 * x + 1.681_534;
        (-x).exp() / x * num / den
    }
}

#[derive(Clone, Copy)]
pub struct Settings {
    pub floor_db: f32,
    pub amount: f32,
    pub thr_db: f32,
    pub decay: f32,
    pub link: bool,
    pub noise_only: bool,
}

impl Default for Settings {
    fn default() -> Self {
        Self { floor_db: 12.0, amount: 1.0, thr_db: 0.0, decay: 0.5, link: true, noise_only: false }
    }
}

pub fn time_constant(decay: f32, floor_db: f32) -> f32 {
    (0.25 * 16f32.powf(decay.clamp(0.0, 1.0)) * 2f32.powf((floor_db - 12.0) / 6.0)).clamp(0.05, 30.0)
}

pub struct Gainer {
    bins: usize,
    ch: usize,
    groups: usize,
    pub set: Settings,
    alpha: f32,
    ln_floor: f32,
    xi_min: f32,
    hop_s: f32,
    print: Vec<Vec<f32>>,
    lam: Vec<Vec<f32>>,
    pub curve: Vec<f32>,
    prev: Vec<Vec<f32>>,
    pub g: Vec<Vec<f32>>,
    p: Vec<f32>,
}

impl Gainer {
    pub fn new(bins: usize, ch: usize, hop_s: f32) -> Self {
        let mut g = Self {
            bins,
            ch,
            groups: 1,
            set: Settings::default(),
            alpha: 0.0,
            ln_floor: 0.0,
            xi_min: 0.0,
            hop_s,
            print: vec![vec![0.0; bins]; ch],
            lam: Vec::new(),
            curve: vec![1.0; bins],
            prev: Vec::new(),
            g: Vec::new(),
            p: vec![0.0; bins],
        };
        g.configure(Settings::default());
        g
    }

    pub fn print_mut(&mut self, c: usize) -> &mut [f32] {
        &mut self.print[c]
    }

    pub fn configure(&mut self, s: Settings) {
        let floor = s.floor_db.clamp(0.0, 60.0);
        self.set = s;
        self.alpha = (-self.hop_s / time_constant(s.decay, floor)).exp();
        self.ln_floor = -floor * std::f32::consts::LN_10 / 20.0;
        self.xi_min = 10f32.powf(-(floor + 10.0) / 10.0);
        let groups = if s.link || self.ch == 1 { 1 } else { self.ch };
        if groups != self.groups || self.g.is_empty() {
            self.groups = groups;
            self.prev = vec![vec![0.0; self.bins]; groups];
            self.g = vec![vec![1.0; self.bins]; groups];
        }
        self.prepare();
    }

    pub fn prepare(&mut self) {
        let beta = 10f32.powf(self.set.thr_db.clamp(-30.0, 30.0) / 10.0);
        self.lam = (0..self.groups)
            .map(|gi| {
                (0..self.bins)
                    .map(|b| {
                        let s: f32 = if self.groups == 1 { self.print.iter().map(|p| p[b]).sum() } else { self.print[gi][b] };
                        (s * beta).max(1e-30)
                    })
                    .collect()
            })
            .collect();
    }

    pub fn reset(&mut self) {
        for p in &mut self.prev {
            p.iter_mut().for_each(|v| *v = 0.0);
        }
    }

    pub fn group_of(&self, c: usize) -> usize {
        if self.groups == 1 { 0 } else { c }
    }

    pub fn frame(&mut self, pw: &[Vec<f32>]) {
        let (a, xm, lnf, bins) = (self.alpha, self.xi_min, self.ln_floor, self.bins);
        let amt = self.set.amount.clamp(0.0, 1.0);
        for gi in 0..self.groups {
            if self.groups == 1 {
                for b in 0..bins {
                    self.p[b] = (0..self.ch).map(|c| pw[c][b]).sum();
                }
            } else {
                self.p.copy_from_slice(&pw[gi]);
            }
            let (lam, prev, out) = (&self.lam[gi], &mut self.prev[gi], &mut self.g[gi]);
            let gmin = lnf.exp();
            for b in 0..bins {
                let p = self.p[b];
                let gam = p / lam[b];
                let xi = (a * prev[b] / lam[b] + (1.0 - a) * (gam - 1.0).max(0.0)).max(xm);
                let w = xi / (1.0 + xi);
                let v = w * gam;
                let g = if v > 24.0 { w } else { (w * (0.5 * e1(v)).exp()).min(1.0) };
                prev[b] = g * g * p;
                let m = amt * self.curve[b];
                let gl = g.max(gmin);
                out[b] = if m >= 1.0 { gl } else if m <= 0.0 { 1.0 } else { (gl.ln() * m).exp() };
            }
        }
    }
}

pub struct Nr {
    pub ch: usize,
    pub st: Stft,
    pub gn: Gainer,
    fifo: Vec<Vec<f32>>,
    filled: usize,
    acc: Vec<Vec<f32>>,
    skip: usize,
    spec: Vec<Vec<Complex<f32>>>,
    pw: Vec<Vec<f32>>,
    outv: Vec<Vec<f32>>,
    pub inp: Vec<f32>,
    pub out: Vec<f32>,
}

impl Nr {
    pub fn new(ch: usize, sr: usize, n: usize, k: usize) -> Self {
        let st = Stft::new(n, k);
        let (bins, hop) = (st.bins, st.hop);
        let gn = Gainer::new(bins, ch, hop as f32 / sr as f32);
        let mut nr = Self {
            ch,
            st,
            gn,
            fifo: vec![vec![0.0; n]; ch],
            filled: 0,
            acc: vec![vec![0.0; n]; ch],
            skip: 0,
            spec: vec![vec![Complex::new(0.0, 0.0); bins]; ch],
            pw: vec![vec![0.0; bins]; ch],
            outv: vec![Vec::new(); ch],
            inp: Vec::new(),
            out: Vec::new(),
        };
        nr.reset();
        nr
    }

    pub fn latency(&self) -> usize {
        self.st.n
    }

    pub fn reset(&mut self) {
        let (n, hop) = (self.st.n, self.st.hop);
        for c in 0..self.ch {
            self.fifo[c].iter_mut().for_each(|v| *v = 0.0);
            self.acc[c].iter_mut().for_each(|v| *v = 0.0);
        }
        self.filled = n - hop;
        self.skip = n - hop;
        self.gn.reset();
    }

    pub fn stage(&mut self, m: usize) -> *mut f32 {
        if self.inp.len() < m * self.ch {
            self.inp.resize(m * self.ch, 0.0);
        }
        self.inp.as_mut_ptr()
    }

    pub fn run(&mut self, m: usize) -> usize {
        let n = self.st.n;
        for v in &mut self.outv {
            v.clear();
        }
        let mut i = 0;
        while i < m {
            let take = (n - self.filled).min(m - i);
            for c in 0..self.ch {
                let src = &self.inp[c * m + i..c * m + i + take];
                self.fifo[c][self.filled..self.filled + take].copy_from_slice(src);
            }
            self.filled += take;
            i += take;
            if self.filled == n {
                self.frame();
            }
        }
        let made = self.outv[0].len();
        self.out.clear();
        for c in 0..self.ch {
            self.out.extend_from_slice(&self.outv[c]);
        }
        made
    }

    fn frame(&mut self) {
        let (n, hop, bins) = (self.st.n, self.st.hop, self.st.bins);
        for c in 0..self.ch {
            self.st.analyze(&self.fifo[c], &mut self.spec[c]);
            for b in 0..bins {
                self.pw[c][b] = self.spec[c][b].norm_sqr();
            }
        }
        self.gn.frame(&self.pw);
        let drop = self.skip.min(hop);
        self.skip -= drop;
        let only = self.gn.set.noise_only;
        for c in 0..self.ch {
            let g = &self.gn.g[self.gn.group_of(c)];
            for b in 0..bins {
                let k = if only { 1.0 - g[b] } else { g[b] };
                self.spec[c][b] *= k;
            }
            self.st.synth(&mut self.spec[c], &mut self.acc[c]);
            let norm = self.st.norm();
            for i in drop..hop {
                self.outv[c].push(self.acc[c][i] * norm[i]);
            }
            self.acc[c].copy_within(hop..n, 0);
            self.acc[c][n - hop..].iter_mut().for_each(|v| *v = 0.0);
            self.fifo[c].copy_within(hop..n, 0);
        }
        self.filled = n - hop;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lcg(seed: &mut u64) -> f32 {
        *seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        ((*seed >> 40) as f32 / (1u64 << 24) as f32) * 2.0 - 1.0
    }

    fn stream(nr: &mut Nr, x: &[Vec<f32>], piece: usize) -> Vec<Vec<f32>> {
        let len = x[0].len();
        let total = len + nr.latency();
        let mut out = vec![Vec::new(); nr.ch];
        let mut pos = 0;
        while pos < total {
            let m = piece.min(total - pos);
            let p = nr.stage(m);
            let buf = unsafe { std::slice::from_raw_parts_mut(p, m * nr.ch) };
            for c in 0..nr.ch {
                for i in 0..m {
                    buf[c * m + i] = x[c].get(pos + i).copied().unwrap_or(0.0);
                }
            }
            let made = nr.run(m);
            for c in 0..nr.ch {
                out[c].extend_from_slice(&nr.out[c * made..(c + 1) * made]);
            }
            pos += m;
        }
        for o in &mut out {
            o.truncate(len);
        }
        out
    }

    #[test]
    fn unity_gain_reconstructs_and_noise_only_is_the_difference() {
        let mut seed = 7u64;
        let x: Vec<Vec<f32>> = (0..2).map(|_| (0..30000).map(|_| lcg(&mut seed) * 0.5).collect()).collect();
        for (n, k) in [(1024, 3), (2048, 4), (4096, 7), (2048, 16), (512, 5)] {
            let mut nr = Nr::new(2, 44100, n, k);
            nr.gn.configure(Settings { floor_db: 0.0, ..Settings::default() });
            for piece in [1, 333, 4096] {
                nr.reset();
                let y = stream(&mut nr, &x, piece);
                for c in 0..2 {
                    assert_eq!(y[c].len(), x[c].len());
                    let e = x[c].iter().zip(&y[c]).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
                    assert!(e < 2e-5, "n {n} k {k} piece {piece} err {e}");
                }
            }
            let mut print = vec![0.0; nr.st.bins];
            print.iter_mut().for_each(|v| *v = 50.0);
            for c in 0..2 {
                nr.gn.print_mut(c).copy_from_slice(&print);
            }
            nr.gn.configure(Settings { floor_db: 20.0, ..Settings::default() });
            nr.reset();
            let y = stream(&mut nr, &x, 1000);
            nr.gn.configure(Settings { floor_db: 20.0, noise_only: true, ..Settings::default() });
            nr.reset();
            let r = stream(&mut nr, &x, 1000);
            for c in 0..2 {
                let e = (0..x[c].len()).map(|i| (x[c][i] - y[c][i] - r[c][i]).abs()).fold(0.0f32, f32::max);
                assert!(e < 3e-5, "split n {n} err {e}");
            }
        }
    }

    #[test]
    fn keeps_a_tone_and_lowers_the_noise_by_the_floor() {
        let sr = 44100;
        let mut seed = 99u64;
        let mut gauss = || {
            let a = (lcg(&mut seed) * 0.5 + 0.5).max(1e-9) as f64;
            let b = (lcg(&mut seed) * 0.5 + 0.5) as f64;
            ((-2.0 * a.ln()).sqrt() * (std::f64::consts::TAU * b).cos()) as f32
        };
        let noise: Vec<f32> = (0..sr * 6).map(|_| gauss() * 0.003).collect();
        let print: Vec<f32> = (0..sr * 2).map(|_| gauss() * 0.003).collect();
        let tone: Vec<f32> = (0..sr * 6).map(|i| if i >= sr * 3 { (std::f64::consts::TAU * 1000.0 * i as f64 / sr as f64).sin() as f32 * 0.3 } else { 0.0 }).collect();
        let x: Vec<f32> = noise.iter().zip(&tone).map(|(a, b)| a + b).collect();
        let mut nr = Nr::new(1, sr, 4096, 7);
        let pr = print_of(&print, 4096, 7).unwrap();
        nr.gn.print_mut(0).copy_from_slice(&pr.mean);
        nr.gn.configure(Settings { floor_db: 15.0, ..Settings::default() });
        let y = stream(&mut nr, &[x.clone()], 2048).remove(0);
        let rms = |v: &[f32]| (v.iter().map(|s| (*s as f64).powi(2)).sum::<f64>() / v.len() as f64).sqrt();
        let quiet = 20.0 * (rms(&y[sr / 2..sr * 5 / 2]) / rms(&noise[sr / 2..sr * 5 / 2])).log10();
        assert!((quiet + 15.0).abs() < 1.0, "noise only lowered by {quiet} dB");
        let t = 20.0 * (rms(&y[sr * 4..sr * 6 - 4096]) / rms(&tone[sr * 4..sr * 6 - 4096])).log10();
        assert!(t.abs() < 0.2, "tone level changed by {t} dB");
        nr.gn.configure(Settings { floor_db: 15.0, amount: 0.0, ..Settings::default() });
        nr.reset();
        let z = stream(&mut nr, &[x.clone()], 2048).remove(0);
        let e = x.iter().zip(&z).map(|(a, b)| (a - b).abs()).fold(0.0f32, f32::max);
        assert!(e < 2e-5, "amount 0 changed the audio by {e}");
    }
}

use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

#[derive(Clone, Copy)]
enum Row {
    Max(usize, usize),
    Lerp(usize, f32),
}

pub struct Spec {
    n: usize,
    fft: Arc<dyn RealToComplex<f32>>,
    win: Vec<f32>,
    inp: Vec<f32>,
    out: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    pow: Vec<f32>,
    rows: Vec<Row>,
    norm: f32,
    pub seg: Vec<f32>,
    pub offs: Vec<u32>,
    pub img: Vec<u8>,
}

pub fn fmin(n: usize, sr: f64) -> f64 {
    (sr / n as f64).max(20.0)
}

impl Spec {
    pub fn new(n: usize) -> Spec {
        let mut pl = RealFftPlanner::<f32>::new();
        let fft = pl.plan_fft_forward(n);
        let win: Vec<f32> = (0..n).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32).collect();
        let sum: f64 = win.iter().map(|&w| w as f64).sum();
        let bins = n / 2 + 1;
        Spec {
            n,
            scratch: fft.make_scratch_vec(),
            fft,
            win,
            inp: vec![0.0; n],
            out: vec![Complex::new(0.0, 0.0); bins],
            pow: vec![0.0; bins],
            rows: Vec::new(),
            norm: (4.0 / (sum * sum)) as f32,
            seg: Vec::new(),
            offs: Vec::new(),
            img: Vec::new(),
        }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    pub fn set_rows(&mut self, rows: usize, sr: f64, log: bool) {
        let n = self.n as f64;
        let last = self.n / 2;
        let nyq = sr / 2.0;
        let lo = if log { fmin(self.n, sr) } else { 0.0 };
        let freq = |u: f64| if log { lo * (nyq / lo).powf(u) } else { nyq * u };
        self.rows.clear();
        for r in 0..rows {
            let u0 = (rows - r - 1) as f64 / rows as f64;
            let u1 = (rows - r) as f64 / rows as f64;
            let b0 = freq(u0) * n / sr;
            let b1 = freq(u1) * n / sr;
            let row = if b1 - b0 >= 1.0 {
                let k0 = (b0.ceil() as usize).min(last);
                let k1 = ((b1.floor() as usize).max(k0)).min(last);
                Row::Max(k0, k1)
            } else {
                let c = ((b0 + b1) / 2.0).clamp(0.0, last as f64);
                let k = (c.floor() as usize).min(last.saturating_sub(1));
                Row::Lerp(k, (c - k as f64) as f32)
            };
            self.rows.push(row);
        }
    }

    pub fn run(&mut self, cols: usize, m: usize, top: f32, range: f32) -> usize {
        let n = self.n;
        let rows = self.rows.len();
        let m = m.max(1);
        self.img.resize(cols * rows, 0);
        let base = top - range;
        let k = 255.0 / range.max(1.0);
        for c in 0..cols {
            self.pow.fill(0.0);
            for w in 0..m {
                let o = self.offs.get(c * m + w).copied().unwrap_or(0) as usize;
                let src = self.seg.get(o..o + n);
                match src {
                    Some(s) => {
                        for i in 0..n {
                            self.inp[i] = s[i] * self.win[i];
                        }
                    }
                    None => self.inp.fill(0.0),
                }
                if self.fft.process_with_scratch(&mut self.inp, &mut self.out, &mut self.scratch).is_err() {
                    continue;
                }
                for (p, v) in self.pow.iter_mut().zip(self.out.iter()) {
                    *p += v.norm_sqr();
                }
            }
            let s = self.norm / m as f32;
            let p = &self.pow;
            let db = |v: f32| 10.0 * (v * s + 1e-30).log10();
            let dst = &mut self.img[c * rows..(c + 1) * rows];
            for (r, row) in self.rows.iter().enumerate() {
                let v = match *row {
                    Row::Max(a, b) => db(p[a..=b].iter().copied().fold(0.0, f32::max)),
                    Row::Lerp(i, f) => db(p[i]) * (1.0 - f) + db(p[i + 1]) * f,
                };
                dst[r] = ((v - base) * k).clamp(0.0, 255.0) as u8;
            }
        }
        cols * rows
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_scale_sine_reads_zero_db_in_its_row() {
        let n = 2048;
        let sr = 44100.0;
        let f = 46.0 * sr / n as f64;
        let mut s = Spec::new(n);
        s.set_rows(400, sr, true);
        s.seg = (0..n * 2).map(|i| (std::f64::consts::TAU * f * i as f64 / sr).sin() as f32).collect();
        s.offs = vec![0, n as u32 / 2];
        let len = s.run(1, 2, 0.0, 120.0);
        assert_eq!(len, 400);
        let peak = *s.img.iter().max().unwrap();
        assert!(peak >= 246, "peak {peak}");
        let lo = fmin(n, sr);
        let u = (f / lo).ln() / ((sr / 2.0) / lo).ln();
        let r = ((1.0 - u) * 400.0) as usize;
        let at = s.img[r.saturating_sub(2)..(r + 3).min(400)].iter().copied().max().unwrap();
        assert!(at >= 246, "row {r} reads {at}");
        let quiet = s.img[..40].iter().copied().max().unwrap();
        assert!(quiet < 40, "high rows read {quiet}");
    }

    #[test]
    fn linear_rows_cover_dc_to_nyquist() {
        let mut s = Spec::new(1024);
        s.set_rows(100, 48000.0, false);
        s.seg = vec![0.5; 1024];
        s.offs = vec![0];
        s.run(1, 1, 0.0, 120.0);
        assert!(s.img[99] > s.img[0]);
    }
}

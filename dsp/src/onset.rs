use realfft::num_complex::Complex;
use realfft::{RealFftPlanner, RealToComplex};
use std::sync::Arc;

const LAG: usize = 2;
const GAMMA: f32 = 1000.0;
const PER_OCTAVE: f64 = 12.0;

pub struct Onset {
    ch: usize,
    n: usize,
    hop: usize,
    fft: Arc<dyn RealToComplex<f32>>,
    win: Vec<f32>,
    norm: f32,
    bands: Vec<(usize, usize)>,
    buf: Vec<f32>,
    head: usize,
    inp: Vec<f32>,
    out: Vec<Complex<f32>>,
    scratch: Vec<Complex<f32>>,
    hist: Vec<Vec<f32>>,
    frames: usize,
    blk: usize,
    acc: f64,
    accr: f64,
    cnt: usize,
    last: f32,
    pub stage: Vec<f32>,
    pub flux: Vec<f32>,
    pub env: Vec<f32>,
    pub envr: Vec<f32>,
}

pub fn size_for(sr: usize) -> usize {
    let mut n = 256;
    while (n as f64) < sr as f64 * 0.02 {
        n *= 2;
    }
    n
}

fn bands_for(n: usize, sr: usize) -> Vec<(usize, usize)> {
    let bin_hz = sr as f64 / n as f64;
    let top = 16000.0f64.min(sr as f64 / 2.0 - bin_hz);
    let mut out: Vec<(usize, usize)> = Vec::new();
    let mut lo = ((30.0 / bin_hz).round() as usize).max(1);
    let mut f = 30.0f64;
    while f < top {
        let f2 = f * 2f64.powf(1.0 / PER_OCTAVE);
        let hi = ((f2 / bin_hz).round() as usize).max(lo + 1).min(n / 2);
        if hi <= lo {
            break;
        }
        out.push((lo, hi));
        lo = hi;
        f = f2.max(hi as f64 * bin_hz);
    }
    out
}

impl Onset {
    pub fn new(ch: usize, sr: usize) -> Onset {
        let n = size_for(sr);
        let hop = n / 4;
        let mut pl = RealFftPlanner::<f32>::new();
        let fft = pl.plan_fft_forward(n);
        let win: Vec<f32> = (0..n).map(|i| (0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / n as f64).cos()) as f32).collect();
        let sum: f32 = win.iter().sum();
        let bands = bands_for(n, sr);
        let nb = bands.len();
        Onset {
            ch,
            n,
            hop,
            scratch: fft.make_scratch_vec(),
            fft,
            win,
            norm: 2.0 / sum,
            bands,
            buf: Vec::with_capacity(n * 4),
            head: 0,
            inp: vec![0.0; n],
            out: vec![Complex::new(0.0, 0.0); n / 2 + 1],
            hist: vec![vec![0.0; nb]; LAG + 1],
            frames: 0,
            blk: ((sr as f64 / 1000.0).round() as usize).max(1),
            acc: 0.0,
            accr: 0.0,
            cnt: 0,
            last: 0.0,
            stage: Vec::new(),
            flux: Vec::new(),
            env: Vec::new(),
            envr: Vec::new(),
        }
    }

    pub fn n(&self) -> usize {
        self.n
    }

    pub fn hop(&self) -> usize {
        self.hop
    }

    pub fn blk(&self) -> usize {
        self.blk
    }

    pub fn bands(&self) -> usize {
        self.bands.len()
    }

    fn frame(&mut self) {
        let s = &self.buf[self.head..self.head + self.n];
        for i in 0..self.n {
            self.inp[i] = s[i] * self.win[i];
        }
        let _ = self.fft.process_with_scratch(&mut self.inp, &mut self.out, &mut self.scratch);
        let slot = self.frames % (LAG + 1);
        let cur = &mut self.hist[slot];
        for (b, &(lo, hi)) in self.bands.iter().enumerate() {
            let mut m = 0.0f32;
            for k in lo..hi {
                m += self.out[k].norm();
            }
            cur[b] = (1.0 + GAMMA * m / (hi - lo) as f32 * self.norm).ln();
        }
        let nb = self.bands.len();
        let mut f = 0.0f32;
        if self.frames >= LAG && nb > 0 {
            let prev = &self.hist[(self.frames - LAG) % (LAG + 1)];
            let cur = &self.hist[slot];
            for b in 0..nb {
                let p = prev[b.saturating_sub(1)].max(prev[b]).max(prev[(b + 1).min(nb - 1)]);
                let d = cur[b] - p;
                if d > 0.0 {
                    f += d;
                }
            }
            f /= nb as f32;
        }
        self.flux.push(f);
        self.frames += 1;
    }

    pub fn feed(&mut self, mono: &[f32]) {
        for &v in mono {
            let d = (v - self.last) as f64;
            self.last = v;
            self.acc += d * d;
            self.accr += (v as f64) * (v as f64);
            self.cnt += 1;
            if self.cnt == self.blk {
                self.env.push((self.acc / self.blk as f64) as f32);
                self.envr.push((self.accr / self.blk as f64) as f32);
                self.acc = 0.0;
                self.accr = 0.0;
                self.cnt = 0;
            }
        }
        self.buf.extend_from_slice(mono);
        while self.buf.len() - self.head >= self.n {
            self.frame();
            self.head += self.hop;
        }
        if self.head > self.n * 8 {
            self.buf.drain(..self.head);
            self.head = 0;
        }
    }

    pub fn feed_staged(&mut self, m: usize) {
        let ch = self.ch;
        let mut mono = vec![0.0f32; m];
        let g = 1.0 / ch as f32;
        for c in 0..ch {
            let src = &self.stage[c * m..(c + 1) * m];
            for i in 0..m {
                mono[i] += src[i] * g;
            }
        }
        self.feed(&mono);
    }

    pub fn finish(&mut self) {
        if self.cnt > 0 {
            self.env.push((self.acc / self.cnt as f64) as f32);
            self.envr.push((self.accr / self.cnt as f64) as f32);
            self.acc = 0.0;
            self.accr = 0.0;
            self.cnt = 0;
        }
        let tail = self.buf.len() - self.head;
        if tail > 0 {
            let pad = self.n - tail.min(self.n);
            self.buf.extend(std::iter::repeat_n(0.0, pad));
            self.frame();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bands_cover_the_range_in_order() {
        for sr in [22050, 44100, 48000, 96000, 192000] {
            let n = size_for(sr);
            let b = bands_for(n, sr);
            assert!(b.len() > 60, "{sr}: {}", b.len());
            for w in b.windows(2) {
                assert_eq!(w[0].1, w[1].0);
                assert!(w[0].0 < w[0].1);
            }
            assert!(b.last().unwrap().1 <= n / 2);
        }
    }

    #[test]
    fn flux_peaks_at_a_hit() {
        let sr = 44100;
        let mut o = Onset::new(1, sr);
        let mut x = vec![0.0f32; sr * 2];
        let mut s = 1u32;
        for (i, v) in x.iter_mut().enumerate() {
            s ^= s << 13;
            s ^= s >> 17;
            s ^= s << 5;
            *v = ((s as f32 / u32::MAX as f32) - 0.5) * 0.002;
            if i >= sr {
                let t = (i - sr) as f32 / sr as f32;
                *v += 0.5 * (-t * 30.0).exp() * (std::f32::consts::TAU * 180.0 * t).sin();
            }
        }
        for c in x.chunks(5000) {
            o.feed(c);
        }
        o.finish();
        let (mut best, mut bi) = (0.0, 0);
        for (i, &f) in o.flux.iter().enumerate() {
            if f > best {
                best = f;
                bi = i;
            }
        }
        let start = bi * o.hop();
        assert!(start <= sr && start + o.n() >= sr, "peak frame {bi} start {start}");
        assert_eq!(o.env.len(), (sr * 2).div_ceil(o.blk()));
        assert_eq!(o.envr.len(), o.env.len());
    }
}

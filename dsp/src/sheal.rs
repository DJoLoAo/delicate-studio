use crate::nr::Stft;
use realfft::num_complex::Complex;
use std::f32::consts::{PI, TAU};

pub const KEEP: f32 = 2.0;
const BIAS: f32 = 1.334_6;
const TONAL: f32 = 0.25;

pub const HEAL: u32 = 0;
pub const REPLACE: u32 = 1;
pub const GAIN: u32 = 2;

fn princ(a: f32) -> f32 {
    a - TAU * ((a + PI) / TAU).floor()
}

struct Rng(u32);

impl Rng {
    fn next(&mut self) -> f32 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x as f32 / u32::MAX as f32
    }
}

pub fn context(n: usize, hop: usize) -> usize {
    n / hop + 2
}

pub struct Heal {
    st: Stft,
    pub x: Vec<f32>,
    pub mask: Vec<u8>,
    pub span: [u32; 2],
    pub keep: f32,
}

impl Heal {
    pub fn new(n: usize) -> Heal {
        Heal { st: Stft::new(n, 4), x: Vec::new(), mask: Vec::new(), span: [0, 0], keep: KEEP }
    }

    pub fn n(&self) -> usize {
        self.st.n
    }

    pub fn hop(&self) -> usize {
        self.st.hop
    }

    pub fn bins(&self) -> usize {
        self.st.bins
    }

    pub fn run(&mut self, frames: usize, mode: u32, gain: f32, seed: u32) -> Option<(usize, usize)> {
        let (n, h, bins) = (self.st.n, self.st.hop, self.st.bins);
        if frames == 0 || self.x.len() < (frames - 1) * h + n || self.mask.len() < frames * bins {
            return None;
        }
        let ctx = context(n, h);
        if frames <= 2 * ctx {
            return None;
        }
        let mut spec = vec![Complex::new(0.0f32, 0.0); frames * bins];
        for f in 0..frames {
            self.st.analyze(&self.x[f * h..f * h + n], &mut spec[f * bins..(f + 1) * bins]);
        }
        let live = |f: usize, k: usize, m: &[u8]| f >= ctx && f < frames - ctx && m[f * bins + k] != 0;
        let mut out = spec.clone();
        let mut changed = vec![false; frames];
        if mode == GAIN {
            for f in 0..frames {
                for k in 0..bins {
                    if live(f, k, &self.mask) {
                        out[f * bins + k] = spec[f * bins + k] * gain;
                        changed[f] = true;
                    }
                }
            }
        } else {
            let lg: Vec<f32> = spec.iter().map(|c| (c.norm() + 1e-12).ln()).collect();
            let cells = frames * bins;
            let (mut lt, mut dt) = (vec![0.0f32; cells], vec![0.0f32; cells]);
            let (mut lf, mut df) = (vec![0.0f32; cells], vec![0.0f32; cells]);
            let mut tone = vec![f32::NAN; cells];
            for k in 0..bins {
                let w = TAU * k as f32 * h as f32 / n as f32;
                let mut f = 0;
                while f < frames {
                    if !live(f, k, &self.mask) {
                        f += 1;
                        continue;
                    }
                    let r0 = f;
                    while f < frames && live(f, k, &self.mask) {
                        f += 1;
                    }
                    let r1 = f;
                    let left = r0.checked_sub(1);
                    let right = if r1 < frames { Some(r1) } else { None };
                    for g in r0..r1 {
                        let i = g * bins + k;
                        match (left, right) {
                            (Some(a), Some(b)) => {
                                let u = (g - a) as f32 / (b - a) as f32;
                                lt[i] = lg[a * bins + k] * (1.0 - u) + lg[b * bins + k] * u;
                                dt[i] = (b - a) as f32;
                            }
                            (Some(a), None) => {
                                lt[i] = lg[a * bins + k];
                                dt[i] = 2.0 * (r1 - r0 + 1) as f32;
                            }
                            (None, Some(b)) => {
                                lt[i] = lg[b * bins + k];
                                dt[i] = 2.0 * (r1 - r0 + 1) as f32;
                            }
                            (None, None) => {}
                        }
                    }
                    if let Some(a) = left.filter(|&a| a >= 2) {
                        let p0 = spec[a * bins + k].arg();
                        let p1 = spec[(a - 1) * bins + k].arg();
                        let p2 = spec[(a - 2) * bins + k].arg();
                        let d1 = princ(p0 - p1 - w);
                        let d2 = princ(p1 - p2 - w);
                        if princ(d1 - d2).abs() < TONAL {
                            let adv = w + d1;
                            for g in r0..r1 {
                                tone[g * bins + k] = p0 + adv * (g - a) as f32;
                            }
                        }
                    }
                }
            }
            for f in 0..frames {
                let mut k = 0;
                while k < bins {
                    if !live(f, k, &self.mask) {
                        k += 1;
                        continue;
                    }
                    let r0 = k;
                    while k < bins && live(f, k, &self.mask) {
                        k += 1;
                    }
                    let r1 = k;
                    let lo = r0.checked_sub(1);
                    let hi = if r1 < bins { Some(r1) } else { None };
                    for q in r0..r1 {
                        let i = f * bins + q;
                        match (lo, hi) {
                            (Some(a), Some(b)) => {
                                let u = (q - a) as f32 / (b - a) as f32;
                                lf[i] = lg[f * bins + a] * (1.0 - u) + lg[f * bins + b] * u;
                                df[i] = (b - a) as f32;
                            }
                            (Some(a), None) => {
                                lf[i] = lg[f * bins + a];
                                df[i] = 2.0 * (r1 - r0 + 1) as f32;
                            }
                            (None, Some(b)) => {
                                lf[i] = lg[f * bins + b];
                                df[i] = 2.0 * (r1 - r0 + 1) as f32;
                            }
                            (None, None) => {}
                        }
                    }
                }
            }
            let mut rng = Rng(seed.max(1));
            let spread = ((n / h) as f32).sqrt();
            for f in 0..frames {
                for k in 0..bins {
                    if !live(f, k, &self.mask) {
                        continue;
                    }
                    let i = f * bins + k;
                    let wt = if dt[i] > 0.0 { 1.0 / (dt[i] * dt[i]) } else { 0.0 };
                    let wf = if df[i] > 0.0 { 1.0 / (df[i] * df[i]) } else { 0.0 };
                    if wt + wf <= 0.0 {
                        continue;
                    }
                    let est = (lt[i] * wt + lf[i] * wf) / (wt + wf);
                    let level = est.exp();
                    if mode == HEAL && spec[i].norm() <= self.keep * BIAS * level {
                        continue;
                    }
                    let ph = tone[i];
                    out[i] = if ph.is_nan() { Complex::from_polar(level * BIAS * spread, TAU * rng.next()) } else { Complex::from_polar(level, ph) };
                    changed[f] = true;
                }
            }
        }
        let first = changed.iter().position(|&c| c)?;
        let last = changed.iter().rposition(|&c| c)?;
        let len = (frames - 1) * h + n;
        let mut acc = vec![0.0f32; len];
        let mut tmp = vec![Complex::new(0.0f32, 0.0); bins];
        let f0 = first.saturating_sub(n / h);
        let f1 = (last + n / h).min(frames - 1);
        for f in f0..=f1 {
            tmp.copy_from_slice(&out[f * bins..(f + 1) * bins]);
            self.st.synth(&mut tmp, &mut acc[f * h..f * h + n]);
        }
        let a = first * h;
        let b = last * h + n;
        let norm = self.st.norm().to_vec();
        for p in a..b {
            self.x[p] = acc[p] * norm[p % h];
        }
        self.span = [a as u32, b as u32];
        Some((a, b))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn noise(n: usize, seed: u32, amp: f32) -> Vec<f32> {
        let mut r = Rng(seed);
        (0..n).map(|_| (r.next() + r.next() + r.next() - 1.5) * amp).collect()
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|&v| (v as f64).powi(2)).sum::<f64>() / x.len().max(1) as f64).sqrt()
    }

    fn setup(x: &[f32], n: usize, j0: usize, j1: usize, k0: usize, k1: usize) -> (Heal, usize, usize) {
        let mut hl = Heal::new(n);
        let h = hl.hop();
        let bins = hl.bins();
        let c = context(n, h) + 2;
        let fa = j0 - c;
        let frames = j1 - j0 + 1 + 2 * c;
        let s0 = fa * h - n / 2;
        hl.x = x[s0..s0 + (frames - 1) * h + n].to_vec();
        hl.mask = vec![0; frames * bins];
        for f in (j0 - fa)..=(j1 - fa) {
            for k in k0..=k1.min(bins - 1) {
                hl.mask[f * bins + k] = 1;
            }
        }
        (hl, frames, s0)
    }

    #[test]
    fn heals_a_click_and_leaves_the_rest_alone() {
        let sr = 44100.0;
        let len = 44100;
        let n = 2048;
        let clean: Vec<f32> = (0..len).map(|i| 0.3 * (TAU * 440.0 * i as f32 / sr).sin()).zip(noise(len, 3, 0.002)).map(|(a, b)| a + b).collect();
        let mut x = clean.clone();
        let at = 22050;
        for i in 0..40 {
            x[at + i] += 0.6 * (-(i as f32) / 6.0).exp() * if i % 2 == 0 { 1.0 } else { -1.0 };
        }
        let h = n / 4;
        let jc = at / h;
        let (mut hl, frames, s0) = setup(&x, n, jc - 2, jc + 2, 0, n / 2);
        let (a, b) = hl.run(frames, HEAL, 1.0, 9).expect("healed");
        let mut y = x.clone();
        y[s0 + a..s0 + b].copy_from_slice(&hl.x[a..b]);
        let before = rms(&x[at - 400..at + 400].iter().zip(&clean[at - 400..at + 400]).map(|(p, q)| p - q).collect::<Vec<_>>());
        let after = rms(&y[at - 400..at + 400].iter().zip(&clean[at - 400..at + 400]).map(|(p, q)| p - q).collect::<Vec<_>>());
        assert!(after < before * 0.2, "click error {before} -> {after}");
        assert!(y[..s0 + a] == x[..s0 + a] && y[s0 + b..] == x[s0 + b..]);
        assert!(b - a <= 9 * h + n, "span {}", b - a);
    }

    #[test]
    fn heals_a_whistle_and_keeps_the_noise_level() {
        let sr = 44100.0;
        let len = 44100 * 3;
        let n = 2048;
        let bg = noise(len, 5, 0.02);
        let f = 3000.0 * n as f32 / sr;
        let k = f.round() as usize;
        let tone_on = 44100..88200;
        let x: Vec<f32> = (0..len).map(|i| bg[i] + if tone_on.contains(&i) { 0.2 * (TAU * 3000.0 * i as f32 / sr).sin() } else { 0.0 }).collect();
        let h = n / 4;
        let (mut hl, frames, s0) = setup(&x, n, tone_on.start / h - 3, tone_on.end / h + 3, k - 3, k + 3);
        let (a, b) = hl.run(frames, HEAL, 1.0, 11).expect("healed");
        let mut y = x.clone();
        y[s0 + a..s0 + b].copy_from_slice(&hl.x[a..b]);
        let mid = 60000..80000;
        let tone_res = y[mid.clone()].iter().zip(&bg[mid.clone()]).map(|(p, q)| p - q).collect::<Vec<_>>();
        let err = rms(&tone_res) / rms(&bg[mid.clone()]);
        assert!(err < 0.4, "residual against the background {err}");
        let lvl = rms(&y[mid.clone()]) / rms(&bg[mid.clone()]);
        assert!((0.85..1.15).contains(&lvl), "noise level ratio {lvl}");
    }

    #[test]
    fn replaces_a_dropout_in_a_held_note() {
        let sr = 44100.0;
        let len = 44100 * 2;
        let n = 2048;
        let clean: Vec<f32> = (0..len).map(|i| 0.4 * (TAU * 1000.0 * i as f32 / sr).sin()).zip(noise(len, 8, 0.001)).map(|(a, b)| a + b).collect();
        let mut x = clean.clone();
        let gap = 40000..53000;
        for v in &mut x[gap.clone()] {
            *v = 0.0;
        }
        let h = n / 4;
        let (mut hl, frames, s0) = setup(&x, n, (gap.start - n / 4) / h, (gap.end + n / 4) / h, 0, n / 2);
        let (a, b) = hl.run(frames, REPLACE, 1.0, 4).expect("healed");
        let mut y = x.clone();
        y[s0 + a..s0 + b].copy_from_slice(&hl.x[a..b]);
        let mid = 43000..50000;
        let lvl = rms(&y[mid.clone()]) / rms(&clean[mid.clone()]);
        assert!((0.9..1.1).contains(&lvl), "level ratio {lvl}");
        let dot: f64 = y[mid.clone()].iter().zip(&clean[mid.clone()]).map(|(p, q)| *p as f64 * *q as f64).sum();
        let corr = dot / (rms(&y[mid.clone()]) * rms(&clean[mid.clone()]) * mid.len() as f64);
        assert!(corr > 0.95, "corr {corr}");
    }

    #[test]
    fn gain_zero_removes_a_band() {
        let sr = 48000.0;
        let len = 48000;
        let n = 2048;
        let x: Vec<f32> = (0..len).map(|i| 0.3 * (TAU * 6000.0 * i as f32 / sr).sin() + 0.3 * (TAU * 500.0 * i as f32 / sr).sin()).collect();
        let h = n / 4;
        let k = (6000.0 * n as f32 / sr) as usize;
        let (mut hl, frames, s0) = setup(&x, n, 30, 60, k - 6, k + 6);
        let (a, b) = hl.run(frames, GAIN, 0.0, 1).expect("ran");
        let mut y = x.clone();
        y[s0 + a..s0 + b].copy_from_slice(&hl.x[a..b]);
        let mid = 40 * h..50 * h;
        let low: Vec<f32> = (0..len).map(|i| 0.3 * (TAU * 500.0 * i as f32 / sr).sin()).collect();
        let err = rms(&y[mid.clone()].iter().zip(&low[mid.clone()]).map(|(p, q)| p - q).collect::<Vec<_>>());
        assert!(err < 0.003, "left over {err}");
    }
}

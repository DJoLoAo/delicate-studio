const HOP: usize = 2048;
const N: usize = 2 * HOP;
const DELTA: usize = 1536;
const CORR_LEN: usize = 1536;
const CORR_STEP: usize = 3;
const REGION: usize = N + 2 * DELTA;

pub struct Stretch {
    ch: usize,
    win: Vec<f32>,
    acc: Vec<Vec<f32>>,
    pending: usize,
    nominal: f64,
    last_a: f64,
    primed: bool,
    rate: f64,
    pitch: f64,
    inw: Vec<Vec<f32>>,
    base: i64,
    sbuf: Vec<Vec<f32>>,
    sbase: i64,
    spos: f64,
    pub stage: Vec<f32>,
    pub out: Vec<f32>,
    mono_n: Vec<f32>,
    mono_r: Vec<f32>,
}

fn hermite(y0: f32, y1: f32, y2: f32, y3: f32, f: f32) -> f32 {
    let c1 = 0.5 * (y2 - y0);
    let c2 = y0 - 2.5 * y1 + 2.0 * y2 - 0.5 * y3;
    let c3 = 0.5 * (y3 - y0) + 1.5 * (y1 - y2);
    ((c3 * f + c2) * f + c1) * f + y1
}

impl Stretch {
    pub fn new(ch: usize) -> Stretch {
        let win = (0..N).map(|i| 0.5 - 0.5 * (std::f64::consts::TAU * i as f64 / N as f64).cos() as f32).collect();
        Stretch {
            ch,
            win,
            acc: vec![vec![0.0; N]; ch],
            pending: 0,
            nominal: 0.0,
            last_a: 0.0,
            primed: false,
            rate: 1.0,
            pitch: 1.0,
            inw: vec![Vec::new(); ch],
            base: 0,
            sbuf: vec![Vec::new(); ch],
            sbase: 0,
            spos: 0.0,
            stage: Vec::new(),
            out: Vec::new(),
            mono_n: vec![0.0; CORR_LEN],
            mono_r: vec![0.0; REGION],
        }
    }

    pub fn begin(&mut self, start: f64, rate: f64, pitch: f64) {
        self.rate = (rate / pitch).clamp(0.05, 20.0);
        self.pitch = pitch.clamp(0.1, 10.0);
        self.nominal = start - HOP as f64 * self.rate;
        self.last_a = self.nominal;
        self.primed = false;
        self.pending = 0;
        for a in &mut self.acc {
            a.iter_mut().for_each(|v| *v = 0.0);
        }
        self.base = self.first();
        for w in &mut self.inw {
            w.clear();
        }
        for s in &mut self.sbuf {
            s.clear();
        }
        self.sbase = 0;
        self.spos = HOP as f64;
    }

    pub fn first(&self) -> i64 {
        self.nominal.floor() as i64 - DELTA as i64 - 2
    }

    fn need(&self) -> i64 {
        if !self.primed {
            return self.nominal.floor() as i64 + N as i64 + 1;
        }
        let a = self.last_a.floor() as i64 + (HOP + CORR_LEN) as i64 + 1;
        let b = self.nominal.floor() as i64 - DELTA as i64 + REGION as i64 + 1;
        a.max(b)
    }

    pub fn need_end(&self) -> i64 {
        self.need()
    }

    pub fn have_end(&self) -> i64 {
        self.base + self.inw[0].len() as i64
    }

    pub fn stage_in(&mut self, m: usize) -> *mut f32 {
        if self.stage.len() < m * self.ch {
            self.stage.resize(m * self.ch, 0.0);
        }
        self.stage.as_mut_ptr()
    }

    pub fn push(&mut self, m: usize) {
        for c in 0..self.ch {
            let s = &self.stage[c * m..(c + 1) * m];
            self.inw[c].extend_from_slice(s);
        }
    }

    fn at(&self, c: usize, pos: i64) -> f32 {
        let i = pos - self.base;
        if i < 0 || i as usize >= self.inw[c].len() { 0.0 } else { self.inw[c][i as usize] }
    }

    fn mono(&self, pos: i64) -> f32 {
        (0..self.ch).map(|c| self.at(c, pos)).sum()
    }

    fn trim(&mut self) {
        let keep = (self.last_a.floor() as i64 + HOP as i64).min(self.nominal.floor() as i64 - DELTA as i64) - 2;
        let drop = keep - self.base;
        if drop > 65536 {
            for w in &mut self.inw {
                w.drain(..drop as usize);
            }
            self.base = keep;
        }
    }

    fn step(&mut self) {
        let a_nom = self.nominal;
        let mut a = a_nom;
        if self.primed {
            let nat0 = self.last_a.floor() as i64 + HOP as i64;
            for j in 0..CORR_LEN {
                self.mono_n[j] = self.mono(nat0 + j as i64);
            }
            let base = a_nom.floor() as i64 - DELTA as i64;
            for j in 0..REGION {
                self.mono_r[j] = self.mono(base + j as i64);
            }
            let mut nat_e = 1e-9f32;
            let mut j = 0;
            while j < CORR_LEN {
                nat_e += self.mono_n[j] * self.mono_n[j];
                j += CORR_STEP;
            }
            let (mut best, mut best_d) = (f32::MIN, DELTA);
            for d in 0..(2 * DELTA) {
                let (mut dot, mut e) = (0.0f32, 1e-9f32);
                let mut j = 0;
                while j < CORR_LEN {
                    let x = self.mono_r[d + j];
                    dot += x * self.mono_n[j];
                    e += x * x;
                    j += CORR_STEP;
                }
                let score = dot / (e * nat_e).sqrt();
                if score > best || (score == best && d == DELTA) {
                    best = score;
                    best_d = d;
                }
            }
            let s0 = base + best_d as i64;
            a = s0 as f64 + (a_nom - a_nom.floor());
            for c in 0..self.ch {
                for i in 0..N {
                    let v = self.at(c, s0 + i as i64) * self.win[i];
                    self.acc[c][i] += v;
                }
            }
        } else {
            let s0 = a.floor() as i64;
            for c in 0..self.ch {
                for i in 0..N {
                    let v = self.at(c, s0 + i as i64) * self.win[i];
                    self.acc[c][i] += v;
                }
            }
            self.primed = true;
        }
        self.last_a = a;
        self.nominal = a_nom + HOP as f64 * self.rate;
        self.pending = HOP;
    }

    fn stretched(&mut self) -> bool {
        if self.pending == 0 {
            if self.need() > self.have_end() {
                return false;
            }
            for a in &mut self.acc {
                a.copy_within(HOP..N, 0);
                a[N - HOP..].iter_mut().for_each(|v| *v = 0.0);
            }
            self.step();
            self.trim();
        }
        let from = HOP - self.pending;
        for c in 0..self.ch {
            let a = &self.acc[c];
            self.sbuf[c].extend_from_slice(&a[from..HOP]);
        }
        self.pending = 0;
        true
    }

    pub fn run(&mut self, want: usize) -> usize {
        let ch = self.ch;
        self.out.resize(ch * want.max(1), 0.0);
        let mut made = 0;
        while made < want {
            let x = self.spos;
            let i = x.floor() as i64;
            let need = i + 3 - self.sbase;
            if need > self.sbuf[0].len() as i64 {
                if !self.stretched() {
                    break;
                }
                continue;
            }
            let f = (x - i as f64) as f32;
            let k = (i - self.sbase) as usize;
            for c in 0..ch {
                let s = &self.sbuf[c];
                let y0 = if k >= 1 { s[k - 1] } else { 0.0 };
                self.out[c * want + made] = hermite(y0, s[k], s[k + 1], s[k + 2], f);
            }
            made += 1;
            self.spos += self.pitch;
            if self.pitch == 1.0 {
                self.spos = x + 1.0;
            }
        }
        let drop = (self.spos.floor() as i64 - 2 - self.sbase).max(0) as usize;
        if drop > 65536 {
            for s in &mut self.sbuf {
                s.drain(..drop);
            }
            self.sbase += drop as i64;
        }
        if made < want {
            for c in 1..ch {
                self.out.copy_within(c * want..c * want + made, c * made);
            }
        }
        made
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;

    fn render(x: &[f32], ch: usize, rate: f64, pitch: f64) -> Vec<Vec<f32>> {
        let n = x.len() / ch;
        let total = (n as f64 / rate).round() as usize;
        let mut s = Stretch::new(ch);
        s.begin(0.0, rate, pitch);
        let mut fed = s.first();
        let mut out = vec![Vec::new(); ch];
        let blk = 4096;
        while out[0].len() < total {
            if s.need_end() > s.have_end() {
                s.stage_in(blk);
                for c in 0..ch {
                    for i in 0..blk {
                        let p = fed + i as i64;
                        s.stage[c * blk + i] = if p >= 0 && (p as usize) < n { x[c * n + p as usize] } else { 0.0 };
                    }
                }
                s.push(blk);
                fed += blk as i64;
                continue;
            }
            let want = (total - out[0].len()).min(blk);
            let got = s.run(want);
            for c in 0..ch {
                out[c].extend_from_slice(&s.out[c * got..(c + 1) * got]);
            }
            if got == 0 {
                continue;
            }
        }
        out
    }

    fn sine(n: usize, f: f64, sr: f64) -> Vec<f32> {
        (0..n).map(|i| (0.5 * (TAU * f * i as f64 / sr).sin()) as f32).collect()
    }

    fn freq(y: &[f32], sr: f64) -> f64 {
        let mut z = 0;
        for i in 1..y.len() {
            if y[i - 1] <= 0.0 && y[i] > 0.0 {
                z += 1;
            }
        }
        z as f64 * sr / y.len() as f64
    }

    #[test]
    fn at_normal_speed_the_audio_comes_through_unchanged() {
        let sr = 44100.0;
        let n = 44100 * 2;
        let mut x = sine(n, 440.0, sr);
        x.extend(sine(n, 660.0, sr));
        let y = render(&x, 2, 1.0, 1.0);
        assert_eq!(y[0].len(), n);
        let d = (0..n).map(|i| (y[0][i] - x[i]).abs().max((y[1][i] - x[n + i]).abs())).fold(0.0f32, f32::max);
        assert!(d < 1e-5, "{d}");
    }

    #[test]
    fn stretching_changes_the_length_and_keeps_the_pitch() {
        let sr = 44100.0;
        let n = 44100 * 3;
        let x = sine(n, 440.0, sr);
        for rate in [0.5, 0.8, 1.25, 2.0] {
            let y = render(&x, 1, rate, 1.0);
            assert_eq!(y[0].len(), (n as f64 / rate).round() as usize);
            let m = y[0].len();
            let f = freq(&y[0][m / 4..m * 3 / 4], sr);
            assert!((f - 440.0).abs() < 4.0, "rate {rate}: {f} Hz");
            let rms = (y[0][m / 4..m * 3 / 4].iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / (m / 2) as f64).sqrt();
            assert!((rms - 0.3536).abs() < 0.03, "rate {rate}: rms {rms}");
        }
    }

    #[test]
    fn pitch_shifting_keeps_the_length_and_moves_the_pitch() {
        let sr = 44100.0;
        let n = 44100 * 3;
        let x = sine(n, 440.0, sr);
        for semis in [-12.0f64, -5.0, 7.0, 12.0] {
            let p = 2f64.powf(semis / 12.0);
            let y = render(&x, 1, 1.0, p);
            assert_eq!(y[0].len(), n);
            let f = freq(&y[0][n / 4..n * 3 / 4], sr);
            assert!((f / (440.0 * p) - 1.0).abs() < 0.01, "{semis}: {f}");
        }
    }
}

use crate::fx::{coefs, Kind};
use crate::loud::Bq;
use std::f64::consts::TAU;

pub const SP_AT: usize = 60;
pub const SP_LEN: usize = 20;

struct Line {
    buf: Vec<f32>,
    pos: usize,
}

impl Line {
    fn new(n: usize) -> Line {
        Line { buf: vec![0.0; n.max(4)], pos: 0 }
    }

    fn push(&mut self, x: f32) {
        self.buf[self.pos] = x;
        self.pos = (self.pos + 1) % self.buf.len();
    }

    fn tap(&self, d: f64) -> f32 {
        let n = self.buf.len();
        let d = d.clamp(1.0, (n - 2) as f64);
        let i = d.floor() as usize;
        let f = (d - i as f64) as f32;
        let a = self.buf[(self.pos + n - i) % n];
        let b = self.buf[(self.pos + n - i - 1) % n];
        a + (b - a) * f
    }

    fn clear(&mut self) {
        self.buf.iter_mut().for_each(|v| *v = 0.0);
        self.pos = 0;
    }
}

struct Comb {
    buf: Vec<f32>,
    pos: usize,
    store: f32,
}

impl Comb {
    fn run(&mut self, x: f32, fb: f32, damp: f32) -> f32 {
        let y = self.buf[self.pos];
        self.store = y * (1.0 - damp) + self.store * damp;
        self.buf[self.pos] = x + self.store * fb;
        self.pos = (self.pos + 1) % self.buf.len();
        y
    }
}

struct Allpass {
    buf: Vec<f32>,
    pos: usize,
}

impl Allpass {
    fn run(&mut self, x: f32) -> f32 {
        let b = self.buf[self.pos];
        let y = b - x;
        self.buf[self.pos] = x + b * 0.5;
        self.pos = (self.pos + 1) % self.buf.len();
        y
    }
}

const COMBS: [usize; 8] = [1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617];
const APS: [usize; 4] = [556, 441, 341, 225];
const SPREAD: usize = 23;

#[derive(Clone, Copy, PartialEq, Default)]
struct Cfg {
    md: i32,
    rate: f64,
    depth: f64,
    mfb: f64,
    mmix: f64,
    dly: bool,
    ms: f64,
    dfb: f64,
    dmix: f64,
    pp: bool,
    rv: bool,
    decay: f64,
    damp: f64,
    pre: f64,
    rmix: f64,
    cut: f64,
    gate: bool,
    grate: f64,
    gdepth: f64,
    square: bool,
}

pub struct Space {
    ch: usize,
    sr: f64,
    cfg: Cfg,
    mline: Vec<Line>,
    mfbv: Vec<f32>,
    aps: Vec<Vec<Bq>>,
    ph: f64,
    dline: Vec<Line>,
    dflt: Vec<(Bq, Bq)>,
    combs: Vec<Vec<Comb>>,
    raps: Vec<Vec<Allpass>>,
    pline: Vec<Line>,
    rcut: Vec<Bq>,
    rfb: f32,
    gph: f64,
    gsm: f32,
}

fn num(c: &[f64], i: usize, lo: f64, hi: f64) -> f64 {
    c[SP_AT + i].clamp(lo, hi)
}

impl Space {
    pub fn new(ch: usize, sr: usize) -> Space {
        let sr = sr as f64;
        let k = sr / 44100.0;
        let scale = |n: usize| ((n as f64 * k).round() as usize).max(1);
        Space {
            ch,
            sr,
            cfg: Cfg::default(),
            mline: (0..ch).map(|_| Line::new((sr * 0.05) as usize + 8)).collect(),
            mfbv: vec![0.0; ch],
            aps: vec![vec![Bq::default(); 4]; ch],
            ph: 0.0,
            dline: (0..ch).map(|_| Line::new((sr * 2.1) as usize)).collect(),
            dflt: vec![(Bq::default(), Bq::default()); ch],
            combs: (0..ch).map(|c| COMBS.iter().map(|&n| Comb { buf: vec![0.0; scale(n + c * SPREAD)], pos: 0, store: 0.0 }).collect()).collect(),
            raps: (0..ch).map(|c| APS.iter().map(|&n| Allpass { buf: vec![0.0; scale(n + c * SPREAD)], pos: 0 }).collect()).collect(),
            pline: (0..ch).map(|_| Line::new((sr * 0.21) as usize)).collect(),
            rcut: vec![Bq::default(); ch],
            rfb: 0.0,
            gph: 0.0,
            gsm: 1.0,
        }
    }

    pub fn configure(&mut self, c: &[f64]) {
        let n = Cfg {
            md: c[SP_AT] as i32,
            rate: num(c, 1, 0.01, 20.0),
            depth: num(c, 2, 0.0, 1.0),
            mfb: num(c, 3, 0.0, 0.95),
            mmix: num(c, 4, 0.0, 1.0),
            dly: c[SP_AT + 5] != 0.0,
            ms: num(c, 6, 1.0, 2000.0),
            dfb: num(c, 7, 0.0, 0.95),
            dmix: num(c, 8, 0.0, 1.0),
            pp: c[SP_AT + 9] != 0.0,
            rv: c[SP_AT + 10] != 0.0,
            decay: num(c, 11, 0.1, 20.0),
            damp: num(c, 12, 0.0, 1.0),
            pre: num(c, 13, 0.0, 200.0),
            rmix: num(c, 14, 0.0, 1.0),
            cut: num(c, 15, 10.0, 2000.0),
            gate: c[SP_AT + 16] != 0.0,
            grate: num(c, 17, 0.05, 40.0),
            gdepth: num(c, 18, 0.0, 1.0),
            square: c[SP_AT + 19] != 0.0,
        };
        let sr = self.sr;
        let (hb, ha) = coefs(Kind::HighPass, sr, 150.0, 0.0, std::f64::consts::FRAC_1_SQRT_2);
        let (lb, la) = coefs(Kind::LowPass, sr, 4500.0, 0.0, std::f64::consts::FRAC_1_SQRT_2);
        for (h, l) in self.dflt.iter_mut() {
            h.b = hb;
            h.a = ha;
            l.b = lb;
            l.a = la;
        }
        let (cb, ca) = coefs(Kind::HighPass, sr, n.cut, 0.0, std::f64::consts::FRAC_1_SQRT_2);
        for q in self.rcut.iter_mut() {
            q.b = cb;
            q.a = ca;
        }
        let avg = COMBS.iter().sum::<usize>() as f64 / COMBS.len() as f64 * sr / 44100.0;
        self.rfb = 10f64.powf(-3.0 * avg / (n.decay * sr)) as f32;
        if n.md != self.cfg.md {
            for l in &mut self.mline {
                l.clear();
            }
            self.mfbv.iter_mut().for_each(|v| *v = 0.0);
            for s in &mut self.aps {
                s.iter_mut().for_each(|q| q.z = [0.0; 2]);
            }
        }
        self.cfg = n;
    }

    pub fn active(&self) -> bool {
        let c = &self.cfg;
        (c.md > 0 && c.mmix > 0.0) || (c.dly && c.dmix > 0.0) || (c.rv && c.rmix > 0.0) || (c.gate && c.gdepth > 0.0)
    }

    pub fn tail(&self) -> usize {
        let c = &self.cfg;
        let mut t = 0.0f64;
        if c.dly && c.dmix > 0.0 {
            let rep = if c.dfb > 0.0 { (-60.0 / (20.0 * c.dfb.log10())).max(1.0) } else { 1.0 };
            t = t.max(c.ms / 1000.0 * (rep + 1.0));
        }
        if c.rv && c.rmix > 0.0 {
            t = t.max(c.decay + c.pre / 1000.0);
        }
        (t * self.sr) as usize
    }

    pub fn reset(&mut self) {
        for l in self.mline.iter_mut().chain(self.dline.iter_mut()).chain(self.pline.iter_mut()) {
            l.clear();
        }
        self.mfbv.iter_mut().for_each(|v| *v = 0.0);
        for s in &mut self.aps {
            s.iter_mut().for_each(|q| q.z = [0.0; 2]);
        }
        for (h, l) in self.dflt.iter_mut() {
            h.z = [0.0; 2];
            l.z = [0.0; 2];
        }
        for c in &mut self.combs {
            for k in c.iter_mut() {
                k.buf.iter_mut().for_each(|v| *v = 0.0);
                k.store = 0.0;
                k.pos = 0;
            }
        }
        for c in &mut self.raps {
            for a in c.iter_mut() {
                a.buf.iter_mut().for_each(|v| *v = 0.0);
                a.pos = 0;
            }
        }
        self.rcut.iter_mut().for_each(|q| q.z = [0.0; 2]);
        self.ph = 0.0;
        self.gph = 0.0;
        self.gsm = 1.0;
    }

    pub fn run(&mut self, x: &mut [f32], m: usize) {
        if !self.active() {
            return;
        }
        let c = self.cfg;
        if c.md > 0 && c.mmix > 0.0 {
            self.modulate(x, m, c);
        }
        if c.dly && c.dmix > 0.0 {
            self.delay(x, m, c);
        }
        if c.rv && c.rmix > 0.0 {
            self.reverb(x, m, c);
        }
        if c.gate && c.gdepth > 0.0 {
            self.gate(x, m, c);
        }
    }

    fn modulate(&mut self, x: &mut [f32], m: usize, c: Cfg) {
        let sr = self.sr;
        let step = TAU * c.rate / sr;
        let mix = c.mmix as f32;
        for i in 0..m {
            let ph = self.ph;
            self.ph = (self.ph + step) % TAU;
            for ch in 0..self.ch {
                let lfo = (ph + ch as f64 * TAU / 4.0).sin();
                let v = x[ch * m + i];
                let wet = match c.md {
                    1 => {
                        self.mline[ch].push(v);
                        let d = (0.015 + 0.008 * c.depth * lfo) * sr;
                        self.mline[ch].tap(d)
                    }
                    2 => {
                        let d = (0.004 * (1.0 + 0.7 * c.depth * lfo)).max(0.0002) * sr;
                        let y = self.mline[ch].tap(d);
                        self.mline[ch].push(v + y * c.mfb as f32);
                        y
                    }
                    _ => {
                        if i % 16 == 0 {
                            for (k, q) in self.aps[ch].iter_mut().enumerate() {
                                let f = (600.0 + 300.0 * k as f64) * (1.0 + 0.8 * c.depth * lfo);
                                let (b, a) = allpass(sr, f.max(40.0), 0.6);
                                q.b = b;
                                q.a = a;
                            }
                        }
                        let mut y = (v + self.mfbv[ch] * c.mfb as f32) as f64;
                        for q in self.aps[ch].iter_mut() {
                            y = q.run(y);
                        }
                        self.mfbv[ch] = y as f32;
                        y as f32
                    }
                };
                x[ch * m + i] = v * (1.0 - mix) + wet * mix;
            }
        }
    }

    fn delay(&mut self, x: &mut [f32], m: usize, c: Cfg) {
        let d = c.ms / 1000.0 * self.sr;
        let (fb, mix) = (c.dfb as f32, c.dmix as f32);
        let pp = c.pp && self.ch == 2;
        for i in 0..m {
            if pp {
                let (l, r) = (x[i], x[m + i]);
                let yl = self.dline[0].tap(d);
                let yr = self.dline[1].tap(d);
                let fl = {
                    let (h, lp) = &mut self.dflt[0];
                    lp.run(h.run(yr as f64)) as f32
                };
                let fr = {
                    let (h, lp) = &mut self.dflt[1];
                    lp.run(h.run(yl as f64)) as f32
                };
                self.dline[0].push((l + r) * 0.5 + fl * fb);
                self.dline[1].push(fr * fb);
                x[i] = l + yl * mix;
                x[m + i] = r + yr * mix;
            } else {
                for ch in 0..self.ch {
                    let v = x[ch * m + i];
                    let y = self.dline[ch].tap(d);
                    let (h, lp) = &mut self.dflt[ch];
                    let f = lp.run(h.run(y as f64)) as f32;
                    self.dline[ch].push(v + f * fb);
                    x[ch * m + i] = v + y * mix;
                }
            }
        }
    }

    fn reverb(&mut self, x: &mut [f32], m: usize, c: Cfg) {
        let pre = (c.pre / 1000.0 * self.sr).max(1.0);
        let damp = (c.damp * 0.4) as f32;
        let fb = self.rfb;
        let wet = c.rmix as f32 * 3.0;
        let ch = self.ch;
        for i in 0..m {
            let mono: f32 = (0..ch).map(|k| x[k * m + i]).sum::<f32>() / ch as f32;
            for k in 0..ch {
                self.pline[k].push(mono);
                let inp = (self.rcut[k].run(self.pline[k].tap(pre) as f64) as f32) * 0.015;
                let mut s = 0.0f32;
                for cb in self.combs[k].iter_mut() {
                    s += cb.run(inp, fb, damp);
                }
                for a in self.raps[k].iter_mut() {
                    s = a.run(s);
                }
                x[k * m + i] += s * wet;
            }
        }
    }

    fn gate(&mut self, x: &mut [f32], m: usize, c: Cfg) {
        let step = c.grate / self.sr;
        let k = 1.0 - (-1.0 / (0.002 * self.sr)).exp() as f32;
        for i in 0..m {
            let p = self.gph;
            self.gph = (self.gph + step) % 1.0;
            let l = if c.square { if p < 0.5 { 1.0 } else { 0.0 } } else { 0.5 + 0.5 * (TAU * p).cos() as f32 };
            let target = 1.0 - c.gdepth as f32 * (1.0 - l);
            self.gsm += (target - self.gsm) * if c.square { k } else { 1.0 };
            for ch in 0..self.ch {
                x[ch * m + i] *= self.gsm;
            }
        }
    }
}

fn allpass(sr: f64, f: f64, q: f64) -> ([f64; 3], [f64; 2]) {
    let w = TAU * f.min(sr * 0.45) / sr;
    let (sn, cs) = w.sin_cos();
    let al = sn / (2.0 * q);
    let a0 = 1.0 + al;
    ([(1.0 - al) / a0, -2.0 * cs / a0, (1.0 + al) / a0], [-2.0 * cs / a0, (1.0 - al) / a0])
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> Vec<f64> {
        vec![0.0; SP_AT + SP_LEN]
    }

    fn set(c: &mut [f64], v: &[(usize, f64)]) {
        for &(i, x) in v {
            c[SP_AT + i] = x;
        }
    }

    fn run(s: &mut Space, x: &[f32], ch: usize) -> Vec<f32> {
        let n = x.len() / ch;
        let mut out = vec![0.0f32; x.len()];
        let blk = 1000;
        let mut o = 0;
        while o < n {
            let k = blk.min(n - o);
            let mut b = vec![0.0f32; ch * k];
            for c in 0..ch {
                b[c * k..(c + 1) * k].copy_from_slice(&x[c * n + o..c * n + o + k]);
            }
            s.run(&mut b, k);
            for c in 0..ch {
                out[c * n + o..c * n + o + k].copy_from_slice(&b[c * k..(c + 1) * k]);
            }
            o += k;
        }
        out
    }

    #[test]
    fn delay_repeats_at_its_time_and_dies_away_with_the_feedback() {
        let sr = 48000;
        let n = sr * 2;
        let mut x = vec![0.0f32; n];
        for i in 0..480 {
            x[100 + i] = (TAU * 1000.0 * i as f64 / sr as f64).sin() as f32;
        }
        let mut s = Space::new(1, sr);
        let mut c = cfg();
        set(&mut c, &[(5, 1.0), (6, 250.0), (7, 0.5), (8, 1.0)]);
        s.configure(&c);
        let y = run(&mut s, &x, 1);
        let d = sr / 4;
        let e = |a: usize| y[a..a + 480].iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        assert!((y[110] - x[110]).abs() < 1e-7);
        let (e1, e2) = (e(100 + d), e(100 + 2 * d));
        assert!(e1 > 0.5 && e1 < 1.01, "{e1}");
        assert!((e2 / e1 - 0.5).abs() < 0.08, "{e1} {e2}");
        assert!(y[700 + d / 2].abs() < 1e-3);
        let t = s.tail() as f64 / sr as f64;
        assert!(t > 2.0 && t < 3.5, "{t}");
    }

    #[test]
    fn ping_pong_alternates_sides() {
        let sr = 44100;
        let n = sr;
        let mut x = vec![0.0f32; 2 * n];
        for i in 0..441 {
            let v = (TAU * 1000.0 * i as f64 / sr as f64).sin() as f32;
            x[10 + i] = v;
            x[n + 10 + i] = v;
        }
        let mut s = Space::new(2, sr);
        let mut c = cfg();
        set(&mut c, &[(5, 1.0), (6, 100.0), (7, 0.6), (8, 1.0), (9, 1.0)]);
        s.configure(&c);
        let y = run(&mut s, &x, 2);
        let d = sr / 10;
        let pk = |o: usize, a: usize| y[o + a..o + a + 441].iter().map(|v| v.abs()).fold(0.0f32, f32::max);
        assert!(pk(0, 10 + d) > 0.5 && pk(n, 10 + d) < 0.01);
        assert!(pk(n, 10 + 2 * d) > 0.2 && pk(0, 10 + 2 * d) < 0.01);
    }

    #[test]
    fn reverb_decays_close_to_its_time() {
        let sr = 48000;
        let n = sr * 4;
        let mut x = vec![0.0f32; n];
        for i in 0..sr / 10 {
            x[i] = ((i * 7919 % 1000) as f32 / 500.0) - 1.0;
        }
        let mut s = Space::new(1, sr);
        let mut c = cfg();
        set(&mut c, &[(10, 1.0), (11, 2.0), (12, 0.0), (13, 0.0), (14, 1.0), (15, 20.0)]);
        s.configure(&c);
        let y = run(&mut s, &x, 1);
        let rms = |a: usize, b: usize| (y[a..b].iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / (b - a) as f64).sqrt();
        let a = rms(sr / 2, sr / 2 + sr / 10);
        let b = rms(sr * 3 / 2, sr * 3 / 2 + sr / 10);
        let drop = 20.0 * (a / b).log10();
        assert!(drop > 22.0 && drop < 38.0, "{drop} dB per second, want about 30");
        assert!(a > 1e-3);
    }

    #[test]
    fn modulation_stays_bounded_and_gate_cuts_half_the_time() {
        let sr = 44100;
        let n = sr;
        let x: Vec<f32> = (0..2 * n).map(|i| (0.5 * (TAU * 440.0 * (i % n) as f64 / sr as f64).sin()) as f32).collect();
        for md in 1..=3 {
            let mut s = Space::new(2, sr);
            let mut c = cfg();
            set(&mut c, &[(0, md as f64), (1, 0.5), (2, 1.0), (3, 0.6), (4, 0.5)]);
            s.configure(&c);
            let y = run(&mut s, &x, 2);
            let pk = y.iter().fold(0.0f32, |a, v| a.max(v.abs()));
            assert!(pk > 0.2 && pk < 2.0, "mode {md}: {pk}");
            assert!(y != x);
        }
        let mut s = Space::new(2, sr);
        let mut c = cfg();
        set(&mut c, &[(16, 1.0), (17, 4.0), (18, 1.0), (19, 1.0)]);
        s.configure(&c);
        let y = run(&mut s, &x, 2);
        let quiet = y[..n].iter().filter(|v| v.abs() < 1e-4).count() as f64 / n as f64;
        assert!(quiet > 0.4 && quiet < 0.55, "{quiet}");
    }

    #[test]
    fn nothing_on_leaves_the_audio_untouched() {
        let mut s = Space::new(2, 48000);
        let mut c = cfg();
        set(&mut c, &[(0, 1.0), (4, 0.0), (5, 1.0), (8, 0.0)]);
        s.configure(&c);
        let x: Vec<f32> = (0..2000).map(|i| (i as f32 * 0.01).sin()).collect();
        let y = run(&mut s, &x, 2);
        assert!(x == y);
    }
}

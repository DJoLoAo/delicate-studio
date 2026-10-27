use crate::loud::{kweight, Bq, Limiter};
use crate::space::{Space, SP_AT, SP_LEN};
use std::f64::consts::{PI, TAU};

pub const MAX_BANDS: usize = 8;
pub const DS_AT: usize = SP_AT + SP_LEN;
pub const CFG_LEN: usize = DS_AT + 4;

#[derive(Clone, Copy, PartialEq)]
pub enum Kind {
    Bell,
    LowShelf,
    HighShelf,
    Notch,
    LowPass,
    HighPass,
}

impl Kind {
    fn of(v: f64) -> Kind {
        match v as i32 {
            1 => Kind::LowShelf,
            2 => Kind::HighShelf,
            3 => Kind::Notch,
            4 => Kind::LowPass,
            5 => Kind::HighPass,
            _ => Kind::Bell,
        }
    }
}

pub fn coefs(kind: Kind, sr: f64, f: f64, gain_db: f64, q: f64) -> ([f64; 3], [f64; 2]) {
    let f = f.clamp(10.0, sr * 0.49);
    let q = q.clamp(0.1, 40.0);
    let a = 10f64.powf(gain_db / 40.0);
    let w = TAU * f / sr;
    let (sn, cs) = w.sin_cos();
    let al = sn / (2.0 * q);
    let (b, a0, a1, a2) = match kind {
        Kind::Bell => ([1.0 + al * a, -2.0 * cs, 1.0 - al * a], 1.0 + al / a, -2.0 * cs, 1.0 - al / a),
        Kind::LowShelf => {
            let s = 2.0 * a.sqrt() * al;
            (
                [a * ((a + 1.0) - (a - 1.0) * cs + s), 2.0 * a * ((a - 1.0) - (a + 1.0) * cs), a * ((a + 1.0) - (a - 1.0) * cs - s)],
                (a + 1.0) + (a - 1.0) * cs + s,
                -2.0 * ((a - 1.0) + (a + 1.0) * cs),
                (a + 1.0) + (a - 1.0) * cs - s,
            )
        }
        Kind::HighShelf => {
            let s = 2.0 * a.sqrt() * al;
            (
                [a * ((a + 1.0) + (a - 1.0) * cs + s), -2.0 * a * ((a - 1.0) + (a + 1.0) * cs), a * ((a + 1.0) + (a - 1.0) * cs - s)],
                (a + 1.0) - (a - 1.0) * cs + s,
                2.0 * ((a - 1.0) - (a + 1.0) * cs),
                (a + 1.0) - (a - 1.0) * cs - s,
            )
        }
        Kind::Notch => ([1.0, -2.0 * cs, 1.0], 1.0 + al, -2.0 * cs, 1.0 - al),
        Kind::LowPass => ([(1.0 - cs) / 2.0, 1.0 - cs, (1.0 - cs) / 2.0], 1.0 + al, -2.0 * cs, 1.0 - al),
        Kind::HighPass => ([(1.0 + cs) / 2.0, -(1.0 + cs), (1.0 + cs) / 2.0], 1.0 + al, -2.0 * cs, 1.0 - al),
    };
    ([b[0] / a0, b[1] / a0, b[2] / a0], [a1 / a0, a2 / a0])
}

pub fn butter_qs(order: usize) -> Vec<f64> {
    let n = order.max(2) / 2 * 2;
    (1..=n / 2).map(|k| 1.0 / (2.0 * (PI * (2 * k - 1) as f64 / (2 * n) as f64).cos())).collect()
}

pub fn response(sec: &[([f64; 3], [f64; 2])], sr: f64, f: f64) -> f64 {
    let w = TAU * f / sr;
    let mut mag = 1.0;
    for (b, a) in sec {
        let (c1, s1) = (w.cos(), w.sin());
        let (c2, s2) = ((2.0 * w).cos(), (2.0 * w).sin());
        let nr = b[0] + b[1] * c1 + b[2] * c2;
        let ni = -(b[1] * s1 + b[2] * s2);
        let dr = 1.0 + a[0] * c1 + a[1] * c2;
        let di = -(a[0] * s1 + a[1] * s2);
        mag *= ((nr * nr + ni * ni) / (dr * dr + di * di)).sqrt();
    }
    20.0 * mag.log10()
}

#[derive(Clone, Copy, PartialEq)]
struct LimCfg {
    on: bool,
    ceil: f64,
    look: f64,
    rel: f64,
}

pub struct Rack {
    pub ch: usize,
    sr: f64,
    sec: Vec<([f64; 3], [f64; 2])>,
    st: Vec<Vec<Bq>>,
    comp: bool,
    thr: f64,
    ratio: f64,
    knee: f64,
    att: f64,
    rel: f64,
    makeup: f32,
    gs: f64,
    drive: f32,
    space: Space,
    ds: bool,
    ds_thr: f64,
    ds_range: f64,
    ds_hp: Vec<Bq>,
    ds_env: f64,
    ds_att: f64,
    ds_rel: f64,
    ds_hi: Vec<f32>,
    lim_cfg: LimCfg,
    lim: Limiter,
    matching: bool,
    kin: Vec<(Bq, Bq)>,
    kout: Vec<(Bq, Bq)>,
    ein: f64,
    eout: f64,
    en: f64,
    mg: f64,
    pub inp: Vec<f32>,
    mid: Vec<f32>,
    pub out: Vec<f32>,
    pub info: [f64; 4],
}

impl Rack {
    pub fn new(ch: usize, sr: usize) -> Rack {
        let kw = kweight(sr as f64);
        let mut lim = Limiter::new(ch, sr);
        lim.configure(0.0, -1.0, 2.0, 100.0, false);
        Rack {
            ch,
            sr: sr as f64,
            sec: Vec::new(),
            st: vec![Vec::new(); ch],
            comp: false,
            thr: 0.0,
            ratio: 1.0,
            knee: 0.0,
            att: 0.0,
            rel: 0.0,
            makeup: 1.0,
            gs: 0.0,
            drive: 1.0,
            space: Space::new(ch, sr),
            ds: false,
            ds_thr: -30.0,
            ds_range: 6.0,
            ds_hp: vec![Bq::default(); 2 * ch],
            ds_env: 0.0,
            ds_att: 0.0,
            ds_rel: 0.0,
            ds_hi: Vec::new(),
            lim_cfg: LimCfg { on: false, ceil: -1.0, look: 2.0, rel: 100.0 },
            lim,
            matching: false,
            kin: vec![kw; ch],
            kout: vec![kw; ch],
            ein: 0.0,
            eout: 0.0,
            en: 0.0,
            mg: 1.0,
            inp: Vec::new(),
            mid: Vec::new(),
            out: Vec::new(),
            info: [0.0; 4],
        }
    }

    pub fn configure(&mut self, c: &[f64]) -> Result<usize, String> {
        if c.len() < CFG_LEN {
            return Err("effects settings are incomplete".into());
        }
        if c.iter().any(|v| !v.is_finite()) {
            return Err("effects settings out of range".into());
        }
        let sr = self.sr;
        let mut sec = Vec::new();
        for (on, f, ord, kind) in [(c[0], c[1], c[2], Kind::HighPass), (c[3], c[4], c[5], Kind::LowPass)] {
            if on != 0.0 {
                for q in butter_qs((ord as usize).clamp(2, 8)) {
                    sec.push(coefs(kind, sr, f, 0.0, q));
                }
            }
        }
        let nb = (c[19] as usize).min(MAX_BANDS);
        for k in 0..nb {
            let o = 20 + 5 * k;
            if c[o] == 0.0 {
                continue;
            }
            let kind = Kind::of(c[o + 1]);
            let g = c[o + 3].clamp(-30.0, 30.0);
            if matches!(kind, Kind::Bell | Kind::LowShelf | Kind::HighShelf) && g.abs() < 1e-9 {
                continue;
            }
            sec.push(coefs(kind, sr, c[o + 2], g, c[o + 4]));
        }
        if sec.len() != self.sec.len() {
            for s in &mut self.st {
                *s = vec![Bq::default(); sec.len()];
            }
        }
        for s in &mut self.st {
            for (q, (b, a)) in s.iter_mut().zip(&sec) {
                q.b = *b;
                q.a = *a;
            }
        }
        self.sec = sec;
        let tc = |ms: f64| (-1.0 / (ms.clamp(0.01, 5000.0) * sr / 1000.0)).exp();
        self.comp = c[6] != 0.0;
        self.thr = c[7].clamp(-80.0, 0.0);
        self.ratio = c[8].clamp(1.0, 100.0);
        self.knee = c[9].clamp(0.0, 40.0);
        self.att = tc(c[10]);
        self.rel = tc(c[11]);
        self.makeup = 10f64.powf(c[12].clamp(-24.0, 40.0) / 20.0) as f32;
        let lc = LimCfg { on: c[13] != 0.0, ceil: c[14].clamp(-12.0, 0.0), look: c[15].clamp(0.5, 20.0), rel: c[16].clamp(1.0, 2000.0) };
        if lc != self.lim_cfg {
            self.lim.configure(0.0, lc.ceil, lc.look, lc.rel, lc.on);
            self.lim_cfg = lc;
        }
        self.drive = 10f64.powf(c[17].clamp(-24.0, 24.0) / 20.0) as f32;
        self.space.configure(c);
        self.ds = c[DS_AT] != 0.0;
        let qs = butter_qs(4);
        let fc = c[DS_AT + 1].clamp(1000.0, 16000.0);
        for (k, q) in self.ds_hp.iter_mut().enumerate() {
            let (b, a) = coefs(Kind::LowPass, sr, fc, 0.0, qs[k % 2]);
            q.b = b;
            q.a = a;
        }
        self.ds_thr = c[DS_AT + 2].clamp(-60.0, 0.0);
        self.ds_range = c[DS_AT + 3].clamp(0.0, 24.0);
        self.ds_att = (-1.0 / (0.0005 * sr)).exp();
        self.ds_rel = (-1.0 / (0.06 * sr)).exp();
        let m = c[18] != 0.0;
        if m != self.matching {
            self.matching = m;
            self.match_reset();
        }
        Ok(self.latency())
    }

    pub fn latency(&self) -> usize {
        self.lim.latency()
    }

    pub fn tail(&self) -> usize {
        self.space.tail()
    }

    fn match_reset(&mut self) {
        let kw = kweight(self.sr);
        self.kin = vec![kw; self.ch];
        self.kout = vec![kw; self.ch];
        self.ein = 0.0;
        self.eout = 0.0;
        self.en = 0.0;
        self.mg = 1.0;
    }

    pub fn reset(&mut self) {
        for s in &mut self.st {
            for q in s.iter_mut() {
                q.z = [0.0; 2];
            }
        }
        self.gs = 0.0;
        self.space.reset();
        self.ds_hp.iter_mut().for_each(|q| q.z = [0.0; 2]);
        self.ds_env = 0.0;
        self.lim.reset();
        self.match_reset();
        self.info = [0.0; 4];
    }

    pub fn stage(&mut self, m: usize) -> *mut f32 {
        if self.inp.len() < m * self.ch {
            self.inp.resize(m * self.ch, 0.0);
        }
        self.inp.as_mut_ptr()
    }

    fn gain_db(&self, x: f64) -> f64 {
        let (t, r, w) = (self.thr, self.ratio, self.knee);
        let d = x - t;
        let y = if 2.0 * d < -w {
            x
        } else if w > 0.0 && 2.0 * d.abs() <= w {
            x + (1.0 / r - 1.0) * (d + w / 2.0).powi(2) / (2.0 * w)
        } else {
            t + d / r
        };
        y - x
    }

    pub fn run(&mut self, m: usize) -> usize {
        let ch = self.ch;
        self.mid.resize(ch * m, 0.0);
        if self.matching {
            for c in 0..ch {
                let (s, h) = &mut self.kin[c];
                for i in 0..m {
                    let v = h.run(s.run(self.inp[c * m + i] as f64));
                    self.ein += v * v / ch as f64;
                }
            }
        }
        for c in 0..ch {
            let st = &mut self.st[c];
            for i in 0..m {
                let mut y = self.inp[c * m + i] as f64;
                for q in st.iter_mut() {
                    y = q.run(y);
                }
                self.mid[c * m + i] = y as f32;
            }
        }
        if self.ds && self.ds_range > 0.0 {
            self.ds_hi.resize(ch * m, 0.0);
            for c in 0..ch {
                for i in 0..m {
                    let x = self.mid[c * m + i] as f64;
                    let y = self.ds_hp[2 * c].run(x);
                    let lo = self.ds_hp[2 * c + 1].run(y);
                    self.ds_hi[c * m + i] = (x - lo) as f32;
                }
            }
            let mut dsg = 0.0f64;
            for i in 0..m {
                let mut pk = 0.0f64;
                for c in 0..ch {
                    pk = pk.max(self.ds_hi[c * m + i].abs() as f64);
                }
                let a = if pk > self.ds_env { self.ds_att } else { self.ds_rel };
                self.ds_env = a * self.ds_env + (1.0 - a) * pk;
                let over = 20.0 * self.ds_env.max(1e-9).log10() - self.ds_thr;
                let cut = over.clamp(0.0, self.ds_range);
                if cut > 0.0 {
                    dsg = dsg.max(cut);
                    let g = 1.0 - 10f64.powf(-cut / 20.0) as f32;
                    for c in 0..ch {
                        self.mid[c * m + i] -= g * self.ds_hi[c * m + i];
                    }
                }
            }
            self.info[3] = self.info[3].max(dsg);
        }
        let mut gr = 0.0f64;
        if self.comp {
            for i in 0..m {
                let mut pk = 0.0f32;
                for c in 0..ch {
                    pk = pk.max(self.mid[c * m + i].abs());
                }
                let x = 20.0 * (pk.max(1e-9) as f64).log10();
                let gc = self.gain_db(x);
                let a = if gc < self.gs { self.att } else { self.rel };
                self.gs = a * self.gs + (1.0 - a) * gc;
                gr = gr.min(self.gs);
                let g = 10f64.powf(self.gs / 20.0) as f32 * self.makeup;
                for c in 0..ch {
                    self.mid[c * m + i] *= g;
                }
            }
        }
        self.space.run(&mut self.mid[..ch * m], m);
        if self.drive != 1.0 {
            for v in self.mid.iter_mut() {
                *v *= self.drive;
            }
        }
        self.info[0] = self.info[0].max(-gr);
        let made = if self.lim_cfg.on {
            self.lim.stage(m);
            self.lim.stage[..ch * m].copy_from_slice(&self.mid[..ch * m]);
            let w = self.lim.run(m);
            self.out.resize(ch * w.max(1), 0.0);
            self.out[..ch * w].copy_from_slice(&self.lim.out[..ch * w]);
            self.info[1] = self.info[1].max(self.lim.gr as f64);
            self.lim.gr = 0.0;
            w
        } else {
            self.out.resize(ch * m, 0.0);
            self.out[..ch * m].copy_from_slice(&self.mid[..ch * m]);
            m
        };
        if self.matching && made > 0 {
            for c in 0..ch {
                let (s, h) = &mut self.kout[c];
                for i in 0..made {
                    let v = h.run(s.run(self.out[c * made + i] as f64));
                    self.eout += v * v / ch as f64;
                }
            }
            self.en += made as f64;
            let span = self.sr * 3.0;
            if self.en > span {
                let k = span / self.en;
                self.ein *= k;
                self.eout *= k;
                self.en = span;
            }
            let target = if self.ein > 1e-12 && self.eout > 1e-12 { (self.ein / self.eout).sqrt().clamp(0.063, 15.85) } else { self.mg };
            let k = 1.0 - (-1.0 / (0.3 * self.sr)).exp();
            for i in 0..made {
                self.mg += (target - self.mg) * k;
                let g = self.mg as f32;
                for c in 0..ch {
                    self.out[c * made + i] *= g;
                }
            }
            self.info[2] = 20.0 * self.mg.log10();
        } else {
            self.info[2] = 0.0;
        }
        made
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sine(n: usize, f: f64, sr: f64, a: f64) -> Vec<f32> {
        (0..n).map(|i| (a * (TAU * f * i as f64 / sr).sin()) as f32).collect()
    }

    fn cfg() -> Vec<f64> {
        let mut c = vec![0.0; CFG_LEN];
        c[1] = 30.0;
        c[2] = 4.0;
        c[4] = 18000.0;
        c[5] = 4.0;
        c[7] = -18.0;
        c[8] = 3.0;
        c[9] = 6.0;
        c[10] = 5.0;
        c[11] = 150.0;
        c[14] = -1.0;
        c[15] = 2.0;
        c[16] = 100.0;
        c
    }

    fn process(r: &mut Rack, x: &[f32], n: usize) -> Vec<f32> {
        let ch = r.ch;
        let blk = 4096;
        let mut out = vec![0.0f32; ch * n];
        let (mut o, mut w) = (0, 0);
        while w < n {
            r.stage(blk);
            for c in 0..ch {
                for i in 0..blk {
                    r.inp[c * blk + i] = if o + i < n { x[c * n + o + i] } else { 0.0 };
                }
            }
            let got = r.run(blk);
            for c in 0..ch {
                for i in 0..got.min(n - w) {
                    out[c * n + w + i] = r.out[c * got + i];
                }
            }
            w += got;
            o += blk;
        }
        out
    }

    fn rms(x: &[f32]) -> f64 {
        (x.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / x.len() as f64).sqrt()
    }

    #[test]
    fn a_rack_with_everything_off_passes_audio_bit_exact() {
        let sr = 48000;
        let n = sr;
        let mut x = sine(n, 440.0, sr as f64, 0.7);
        x.extend(sine(n, 3000.0, sr as f64, 0.2));
        let mut r = Rack::new(2, sr);
        assert_eq!(r.configure(&cfg()).unwrap(), 0);
        let y = process(&mut r, &x, n);
        assert!(x == y);
    }

    #[test]
    fn eq_bands_hit_their_gain_at_the_centre_and_stay_flat_away_from_it() {
        let sr = 48000.0;
        let (b, a) = coefs(Kind::Bell, sr, 1000.0, 6.0, 0.7);
        assert!((response(&[(b, a)], sr, 1000.0) - 6.0).abs() < 1e-9);
        assert!(response(&[(b, a)], sr, 20.0).abs() < 0.05);
        let (b, a) = coefs(Kind::LowShelf, sr, 200.0, -12.0, std::f64::consts::FRAC_1_SQRT_2);
        assert!((response(&[(b, a)], sr, 20.0) + 12.0).abs() < 0.1);
        assert!((response(&[(b, a)], sr, 200.0) + 6.0).abs() < 1e-6);
        assert!(response(&[(b, a)], sr, 10000.0).abs() < 0.05);
        let (b, a) = coefs(Kind::HighShelf, sr, 2500.0, 9.0, std::f64::consts::FRAC_1_SQRT_2);
        assert!((response(&[(b, a)], sr, 2500.0) - 4.5).abs() < 1e-6);
        assert!((response(&[(b, a)], sr, 20000.0) - 9.0).abs() < 0.2);
        let (b, a) = coefs(Kind::Notch, sr, 60.0, 0.0, 10.0);
        assert!(response(&[(b, a)], sr, 60.0) < -100.0);
    }

    #[test]
    fn cuts_are_butterworth_with_the_chosen_slope() {
        let sr = 96000.0;
        for (ord, slope) in [(2usize, 12.0), (4, 24.0), (8, 48.0)] {
            let sec: Vec<_> = butter_qs(ord).into_iter().map(|q| coefs(Kind::HighPass, sr, 100.0, 0.0, q)).collect();
            assert!((response(&sec, sr, 100.0) + 3.0103).abs() < 0.01, "order {ord}");
            let d = response(&sec, sr, 25.0) - response(&sec, sr, 12.5);
            assert!((d - slope).abs() < 0.3, "order {ord}: {d} dB per octave");
            assert!(response(&sec, sr, 1000.0).abs() < 0.01);
        }
    }

    #[test]
    fn the_rack_runs_the_eq_it_describes() {
        let sr = 48000;
        let n = sr * 2;
        let mut c = cfg();
        c[19] = 1.0;
        c[20] = 1.0;
        c[21] = 0.0;
        c[22] = 1000.0;
        c[23] = -9.0;
        c[24] = 1.4;
        let x = sine(n, 1000.0, sr as f64, 0.5);
        let mut r = Rack::new(1, sr);
        r.configure(&c).unwrap();
        let y = process(&mut r, &x, n);
        let got = 20.0 * (rms(&y[sr..]) / rms(&x[sr..])).log10();
        assert!((got + 9.0).abs() < 0.02, "{got}");
    }

    #[test]
    fn the_compressor_settles_on_its_static_curve() {
        let sr = 48000;
        let n = sr * 3;
        let mut c = cfg();
        c[6] = 1.0;
        c[7] = -20.0;
        c[8] = 4.0;
        c[9] = 0.0;
        c[10] = 1.0;
        c[11] = 50.0;
        c[12] = 0.0;
        let mut r = Rack::new(1, sr);
        r.configure(&c).unwrap();
        let x: Vec<f32> = (0..n).map(|_| 0.5).collect();
        let y = process(&mut r, &x, n);
        let want = -20.0 + (20.0 * 0.5f64.log10() + 20.0) / 4.0;
        let got = 20.0 * (y[n - 1] as f64).log10();
        assert!((got - want).abs() < 0.01, "{got} vs {want}");
        assert!((r.info[0] - (20.0 * 0.5f64.log10() - want)).abs() < 0.05, "{}", r.info[0]);
        c[9] = 10.0;
        r.configure(&c).unwrap();
        assert!((r.gain_db(-20.0) - (1.0 / 4.0 - 1.0) * 25.0 / 20.0).abs() < 1e-9);
        assert!(r.gain_db(-25.01).abs() < 1e-12);
        assert!((r.gain_db(-10.0) - (-20.0 + 10.0 / 4.0 + 10.0)).abs() < 1e-9);
    }

    #[test]
    fn the_limiter_holds_its_ceiling_after_drive() {
        let sr = 44100;
        let n = sr * 2;
        let mut c = cfg();
        c[13] = 1.0;
        c[14] = -1.0;
        c[17] = 12.0;
        let mut x = sine(n, 997.0, sr as f64, 0.5);
        x.extend(sine(n, 523.0, sr as f64, 0.4));
        let mut r = Rack::new(2, sr);
        let lat = r.configure(&c).unwrap();
        assert!(lat > 0);
        let y = process(&mut r, &x, n);
        let pk = y.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!(20.0 * (pk as f64).log10() <= -1.0, "{pk}");
        assert!(r.info[1] > 5.0);
        let i = sr / 2;
        assert!((y[i + 100] as f64 / (x[i + 100] as f64 * 3.981)).abs() <= 1.0001);
    }

    #[test]
    fn the_de_esser_turns_down_only_the_loud_highs() {
        let sr = 48000;
        let n = sr * 2;
        let lo = sine(n, 300.0, sr as f64, 0.5);
        let hi = sine(n, 10000.0, sr as f64, 0.3);
        let x: Vec<f32> = lo.iter().zip(&hi).map(|(a, b)| a + b).collect();
        let mut c = cfg();
        c[DS_AT] = 1.0;
        c[DS_AT + 1] = 5000.0;
        c[DS_AT + 2] = -30.0;
        c[DS_AT + 3] = 9.0;
        let mut r = Rack::new(1, sr);
        r.configure(&c).unwrap();
        let y = process(&mut r, &x, n);
        let band = |v: &[f32], f: f64| {
            let (mut re, mut im) = (0.0f64, 0.0f64);
            for (i, s) in v.iter().enumerate() {
                let p = TAU * f * i as f64 / sr as f64;
                re += *s as f64 * p.cos();
                im += *s as f64 * p.sin();
            }
            (re * re + im * im).sqrt() * 2.0 / v.len() as f64
        };
        let tail = &y[sr..];
        let h = 20.0 * (band(tail, 10000.0) / 0.3).log10();
        let l = 20.0 * (band(tail, 300.0) / 0.5).log10();
        assert!((h + 9.0).abs() < 1.0, "highs {h}");
        assert!(l.abs() < 0.3, "lows {l}");
        assert!((r.info[3] - 9.0).abs() < 0.01);
        c[DS_AT + 2] = 0.0;
        r.configure(&c).unwrap();
        r.reset();
        let quiet: Vec<f32> = lo.iter().map(|v| v * 0.5).collect();
        let y = process(&mut r, &quiet, n);
        assert!(y == quiet);
    }

    #[test]
    fn level_match_brings_the_processed_sound_back_to_the_original_loudness() {
        let sr = 48000;
        let n = sr * 8;
        let mut c = cfg();
        c[17] = 9.0;
        c[18] = 1.0;
        let x = sine(n, 1000.0, sr as f64, 0.05);
        let mut r = Rack::new(1, sr);
        r.configure(&c).unwrap();
        let y = process(&mut r, &x, n);
        let d = 20.0 * (rms(&y[n - sr..]) / rms(&x[n - sr..])).log10();
        assert!(d.abs() < 0.1, "{d}");
        assert!((r.info[2] + 9.0).abs() < 0.1, "{}", r.info[2]);
        c[18] = 0.0;
        r.configure(&c).unwrap();
        let y = process(&mut r, &x, n);
        let d = 20.0 * (rms(&y[n - sr..]) / rms(&x[n - sr..])).log10();
        assert!((d - 9.0).abs() < 0.01, "{d}");
    }
}

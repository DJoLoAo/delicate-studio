use realfft::num_complex::Complex;
use realfft::{ComplexToReal, RealFftPlanner, RealToComplex};
use std::f64::consts::PI;
use std::sync::Arc;

#[derive(Clone, Copy, Default)]
struct Bq {
    b: [f64; 3],
    a: [f64; 2],
    z: [f64; 2],
}

impl Bq {
    fn lowpass(sr: f64, fc: f64, q: f64) -> Bq {
        let w = 2.0 * PI * fc / sr;
        let (s, c) = w.sin_cos();
        let al = s / (2.0 * q);
        let a0 = 1.0 + al;
        let b1 = (1.0 - c) / a0;
        Bq { b: [b1 / 2.0, b1, b1 / 2.0], a: [-2.0 * c / a0, (1.0 - al) / a0], z: [0.0; 2] }
    }

    fn run(&mut self, x: f64) -> f64 {
        let y = self.b[0] * x + self.z[0];
        self.z[0] = self.b[1] * x - self.a[0] * y + self.z[1];
        self.z[1] = self.b[2] * x - self.a[1] * y;
        y
    }
}

const NTHR: usize = 100;
const MAXC: usize = 12;

pub struct Melody {
    ch: usize,
    dec: usize,
    pub srd: f64,
    w: usize,
    tmin: usize,
    tmax: usize,
    pub hop: usize,
    n: usize,
    lp: Vec<Bq>,
    phase: usize,
    pub stage: Vec<f32>,
    ring: Vec<f32>,
    base: usize,
    next: usize,
    fwd: Arc<dyn RealToComplex<f32>>,
    inv: Arc<dyn ComplexToReal<f32>>,
    ta: Vec<f32>,
    tb: Vec<f32>,
    fa: Vec<Complex<f32>>,
    fb: Vec<Complex<f32>>,
    sc: Vec<Complex<f32>>,
    corr: Vec<f32>,
    dn: Vec<f64>,
    thr: Vec<f64>,
    cf: Vec<f32>,
    cp: Vec<f32>,
    co: Vec<u32>,
    pub rms: Vec<f32>,
    pub notes: Vec<f64>,
    pub track: Vec<f32>,
    pub tuning: f64,
}

fn beta_weights() -> Vec<f64> {
    let mut w: Vec<f64> = (1..=NTHR).map(|i| {
        let x = i as f64 / NTHR as f64;
        if x >= 1.0 { 0.0 } else { x * (1.0 - x).powi(17) }
    }).collect();
    let s: f64 = w.iter().sum();
    for v in &mut w {
        *v /= s;
    }
    w
}

impl Melody {
    pub fn new(ch: usize, sr: usize, fmin: f64, fmax: f64) -> Melody {
        let sr = sr as f64;
        let want = (fmax * 12.0).max(16000.0);
        let dec = ((sr / want).floor() as usize).max(1);
        let srd = sr / dec as f64;
        let tmax = (srd / fmin).ceil() as usize + 1;
        let tmin = ((srd / fmax).floor() as usize).max(2);
        let w = tmax.next_power_of_two().clamp(256, 4096).max(tmax);
        let hop = ((srd / 200.0).round() as usize).max(1);
        let n = (w + w + tmax).next_power_of_two();
        let mut planner = RealFftPlanner::<f32>::new();
        let fwd = planner.plan_fft_forward(n);
        let inv = planner.plan_fft_inverse(n);
        let lp = if dec > 1 {
            let fc = 0.42 * srd;
            [0.5098, 0.6013, 0.9000, 2.5629].iter().map(|&q| Bq::lowpass(sr, fc, q)).collect()
        } else {
            Vec::new()
        };
        Melody {
            ch,
            dec,
            srd,
            w,
            tmin,
            tmax,
            hop,
            n,
            lp,
            phase: 0,
            stage: Vec::new(),
            ring: Vec::new(),
            base: 0,
            next: 0,
            ta: fwd.make_input_vec(),
            tb: fwd.make_input_vec(),
            fa: fwd.make_output_vec(),
            fb: fwd.make_output_vec(),
            sc: fwd.make_output_vec(),
            corr: inv.make_output_vec(),
            fwd,
            inv,
            dn: vec![0.0; tmax + 2],
            thr: beta_weights(),
            cf: Vec::new(),
            cp: Vec::new(),
            co: vec![0],
            rms: Vec::new(),
            notes: Vec::new(),
            track: Vec::new(),
            tuning: 0.0,
        }
    }

    pub fn frame_t0(&self) -> f64 {
        self.w as f64 / 2.0 / self.srd
    }

    pub fn frame_dt(&self) -> f64 {
        self.hop as f64 / self.srd
    }

    pub fn frames(&self) -> usize {
        self.rms.len()
    }

    pub fn feed_staged(&mut self, m: usize) {
        let st = std::mem::take(&mut self.stage);
        self.feed(&st, m);
        self.stage = st;
    }

    pub fn feed(&mut self, x: &[f32], m: usize) {
        let g = 1.0 / self.ch as f64;
        for i in 0..m {
            let mut s = 0.0;
            for c in 0..self.ch {
                s += x[c * m + i] as f64;
            }
            let mut v = s * g;
            for b in &mut self.lp {
                v = b.run(v);
            }
            if self.phase == 0 {
                self.ring.push(v as f32);
            }
            self.phase += 1;
            if self.phase == self.dec {
                self.phase = 0;
            }
        }
        self.process(false);
    }

    fn process(&mut self, flush: bool) {
        let need = self.w + self.tmax;
        loop {
            let have = self.base + self.ring.len();
            if self.next + need > have {
                if !flush || self.next >= have {
                    break;
                }
            }
            let off = self.next - self.base;
            let end = (off + need).min(self.ring.len());
            self.frame(off, end);
            self.next += self.hop;
        }
        let keep_from = self.next.saturating_sub(self.base);
        if keep_from > 0 && keep_from <= self.ring.len() && keep_from > 1 << 16 {
            self.ring.drain(..keep_from);
            self.base += keep_from;
        }
    }

    fn frame(&mut self, off: usize, end: usize) {
        let (w, tmax, n) = (self.w, self.tmax, self.n);
        let len = end - off;
        for v in self.ta.iter_mut() {
            *v = 0.0;
        }
        for v in self.tb.iter_mut() {
            *v = 0.0;
        }
        let seg = &self.ring[off..end];
        for j in 0..w.min(len) {
            self.ta[j] = seg[j];
        }
        for j in 0..len {
            self.tb[j] = seg[j];
        }
        let _ = self.fwd.process(&mut self.ta, &mut self.fa);
        let _ = self.fwd.process(&mut self.tb, &mut self.fb);
        for k in 0..self.sc.len() {
            self.sc[k] = self.fa[k].conj() * self.fb[k];
        }
        self.sc[0].im = 0.0;
        let last = self.sc.len() - 1;
        self.sc[last].im = 0.0;
        let _ = self.inv.process(&mut self.sc, &mut self.corr);
        let nf = n as f64;
        let mut cum = vec![0.0f64; len + 1];
        for j in 0..len {
            cum[j + 1] = cum[j] + (seg[j] as f64) * (seg[j] as f64);
        }
        let e = |a: usize| -> f64 {
            let b = (a + w).min(len);
            if a >= b { 0.0 } else { cum[b] - cum[a] }
        };
        let e0 = e(0);
        let rms_db = 10.0 * (e0 / w as f64 + 1e-20).log10();
        self.rms.push(rms_db as f32);
        let top = tmax.min(len.saturating_sub(1));
        self.dn[0] = 1.0;
        let mut run = 0.0;
        for t in 1..=tmax {
            let d = if t <= top { (e0 + e(t) - 2.0 * self.corr[t] as f64 / nf).max(0.0) } else { e0 };
            run += d;
            self.dn[t] = if run > 0.0 { d * t as f64 / run } else { 1.0 };
        }
        let mut mins: Vec<(usize, f64)> = Vec::new();
        let lo = self.tmin.max(2);
        for t in lo..tmax {
            if self.dn[t] < self.dn[t - 1] && self.dn[t] <= self.dn[t + 1] {
                mins.push((t, self.dn[t]));
            }
        }
        let mut probs = vec![0.0f64; mins.len()];
        if !mins.is_empty() {
            let gmin = mins.iter().enumerate().min_by(|a, b| a.1 .1.partial_cmp(&b.1 .1).unwrap()).map(|x| x.0).unwrap();
            for (i, &wt) in self.thr.iter().enumerate() {
                let th = (i + 1) as f64 / NTHR as f64;
                match mins.iter().position(|m| m.1 < th) {
                    Some(k) => probs[k] += wt,
                    None => probs[gmin] += wt * 0.01,
                }
            }
        }
        let mut order: Vec<usize> = (0..mins.len()).filter(|&i| probs[i] > 1e-4).collect();
        order.sort_by(|a, b| probs[*b].partial_cmp(&probs[*a]).unwrap());
        order.truncate(MAXC);
        for i in order {
            let (t, _) = mins[i];
            let (a, b, c) = (self.dn[t - 1], self.dn[t], self.dn[t + 1]);
            let den = a - 2.0 * b + c;
            let sh = if den.abs() > 1e-12 { (0.5 * (a - c) / den).clamp(-1.0, 1.0) } else { 0.0 };
            let tau = t as f64 + sh;
            self.cf.push((self.srd / tau) as f32);
            self.cp.push(probs[i] as f32);
        }
        self.co.push(self.cf.len() as u32);
    }

    pub fn finish(&mut self, sens: f64, min_len: f64, follow: bool) -> usize {
        self.process(true);
        let nf = self.rms.len();
        self.notes.clear();
        self.track = vec![f32::NAN; nf];
        if nf == 0 {
            return 0;
        }
        let peak = self.rms.iter().cloned().fold(-200.0f32, f32::max) as f64;
        let gate = (peak - 45.0).max(-65.0);
        let kv = 4f64.powf((sens - 0.5) * 2.0);
        let midi = |f: f32| 69.0 + 12.0 * ((f as f64) / 440.0).log2();
        let ln = |p: f64| (p.max(1e-9)).ln();
        let stay = ln(0.99);
        let sw = ln(0.01);
        let b = 0.35;
        let jump = |d: f64| ln(0.9 / (2.0 * b) * (-d.abs() / b).exp() + 0.1 / 48.0);
        let mut prev: Vec<f64> = Vec::new();
        let mut prev_m: Vec<f64> = Vec::new();
        let mut back: Vec<u8> = Vec::new();
        let mut boff: Vec<u32> = vec![0];
        for t in 0..nf {
            let (a, z) = (self.co[t] as usize, self.co[t + 1] as usize);
            let voiced_ok = self.rms[t] as f64 >= gate;
            let k = if voiced_ok { z - a } else { 0 };
            let psum: f64 = if voiced_ok { (a..z).map(|i| self.cp[i] as f64).sum() } else { 0.0 };
            let puv = (1.0 - psum).max(1e-3);
            let cur_m: Vec<f64> = (a..a + k).map(|i| midi(self.cf[i])).collect();
            let mut cur = vec![0.0f64; k + 1];
            for s in 0..=k {
                let obs = if s < k { ln(self.cp[a + s] as f64 * kv) } else { ln(puv) };
                if t == 0 {
                    cur[s] = obs;
                    back.push(0);
                    continue;
                }
                let pk = prev.len() - 1;
                let mut best = f64::NEG_INFINITY;
                let mut arg = 0usize;
                for (q, &sc) in prev.iter().enumerate() {
                    let tr = match (q < pk, s < k) {
                        (true, true) => stay + jump(cur_m[s] - prev_m[q]),
                        (false, false) => stay,
                        _ => sw,
                    };
                    let v = sc + tr;
                    if v > best {
                        best = v;
                        arg = q;
                    }
                }
                cur[s] = best + obs;
                back.push(arg as u8);
            }
            boff.push(back.len() as u32);
            prev = cur;
            prev_m = cur_m;
        }
        let mut s = prev.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap()).map(|x| x.0).unwrap();
        let mut path = vec![0usize; nf];
        for t in (0..nf).rev() {
            path[t] = s;
            s = back[boff[t] as usize + s] as usize;
        }
        let mut raw = vec![f64::NAN; nf];
        for t in 0..nf {
            let (a, z) = (self.co[t] as usize, self.co[t + 1] as usize);
            let voiced_ok = self.rms[t] as f64 >= gate;
            let k = if voiced_ok { z - a } else { 0 };
            if path[t] < k {
                raw[t] = midi(self.cf[a + path[t]]);
            }
        }
        let tm = raw;
        let mut onset = vec![false; nf];
        let mut last_on = -100i64;
        for t in 4..nf {
            let lo = (t - 4..t).map(|i| self.rms[i]).fold(f32::INFINITY, f32::min) as f64;
            if self.rms[t] as f64 - lo > 6.0 && self.rms[t] as f64 > gate + 6.0 && t as i64 - last_on > 10 {
                onset[t] = true;
                last_on = t as i64;
            }
        }
        let mut oc = vec![0u32; nf + 1];
        for t in 0..nf {
            oc[t + 1] = oc[t] + onset[t] as u32;
        }
        let any_on = |a: usize, b: usize| -> bool { let (a, b) = (a.min(nf), b.min(nf)); b > a && oc[b] > oc[a] };
        let mut segs: Vec<(usize, usize)> = Vec::new();
        let mut st: Option<usize> = None;
        let mut gap = 0usize;
        let mut dev = 0usize;
        let mut lastv = 0usize;
        let mut t = 0usize;
        while t < nf {
            let v = tm[t].is_finite();
            match st {
                None => {
                    if v {
                        st = Some(t);
                        gap = 0;
                        dev = 0;
                    }
                }
                Some(s0) => {
                    if !v {
                        gap += 1;
                        if gap > 3 {
                            segs.push((s0, t + 1 - gap));
                            st = None;
                        }
                    } else {
                        gap = 0;
                        let from = s0.max(t.saturating_sub(14));
                        let mut hist: Vec<f64> = (from..t).filter_map(|i| if tm[i].is_finite() { Some(tm[i]) } else { None }).collect();
                        let refm = if hist.is_empty() { tm[t] } else { median(&mut hist) };
                        if t > s0 + 2 && any_on(lastv + 1, t + 1) {
                            segs.push((s0, t));
                            st = Some(t);
                            dev = 0;
                        } else if (tm[t] - refm).abs() > 0.75 {
                            dev += 1;
                            if dev >= 3 {
                                let cut = t + 1 - dev;
                                if cut > s0 {
                                    segs.push((s0, cut));
                                }
                                st = Some(cut);
                                dev = 0;
                            }
                        } else {
                            dev = 0;
                        }
                    }
                }
            }
            if v {
                lastv = t;
            }
            t += 1;
        }
        if let Some(s0) = st {
            segs.push((s0, nf - gap));
        }
        let centre = |a: usize, z: usize| -> Option<f64> {
            let mut v: Vec<f64> = (a..z).filter_map(|i| if tm[i].is_finite() { Some(tm[i]) } else { None }).collect();
            if v.is_empty() {
                return None;
            }
            v.sort_by(|x, y| x.partial_cmp(y).unwrap());
            let q = |f: f64| v[((v.len() - 1) as f64 * f).round() as usize];
            Some(0.5 * (q(0.1) + q(0.9)))
        };
        self.tuning = 0.0;
        if follow {
            let (mut sx, mut sy) = (0.0, 0.0);
            for &(a, z) in &segs {
                if let Some(c) = centre(a, z) {
                    let wgt = (z - a) as f64;
                    let ang = 2.0 * PI * (c - c.round());
                    sx += wgt * ang.cos();
                    sy += wgt * ang.sin();
                }
            }
            if sx != 0.0 || sy != 0.0 {
                self.tuning = sy.atan2(sx) / (2.0 * PI);
            }
        }
        for t in 0..nf {
            self.track[t] = (tm[t] - self.tuning) as f32;
        }
        let dt = self.frame_dt();
        let t0 = self.frame_t0() - dt / 2.0;
        let mut out: Vec<(f64, f64, i32, f64)> = Vec::new();
        for (a, z) in segs {
            let Some(c) = centre(a, z) else { continue };
            let p = (c - self.tuning).round() as i32;
            let top = (a..z).map(|i| self.rms[i]).fold(f32::NEG_INFINITY, f32::max) as f64;
            let ts = t0 + a as f64 * dt;
            let te = t0 + z as f64 * dt;
            if let Some(l) = out.last_mut() {
                if (l.2 == p || (l.2 - p).abs() == 12) && ts - l.1 < 0.04 && !any_on(a.saturating_sub(3), a + 3) {
                    l.1 = te;
                    l.3 = l.3.max(top);
                    continue;
                }
            }
            out.push((ts, te, p, top));
        }
        out.retain(|n| n.1 - n.0 >= min_len);
        for (ts, te, p, top) in out {
            let vel = (112.0 + (top - peak) * 2.2).round().clamp(20.0, 127.0);
            self.notes.extend_from_slice(&[ts.max(0.0), te, p as f64, vel]);
        }
        self.notes.len() / 4
    }
}

fn median(v: &mut [f64]) -> f64 {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { 0.5 * (v[n / 2 - 1] + v[n / 2]) }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn synth(sr: usize, notes: &[(f64, f64, f64)], cents: f64, vib: f64, noise: f64) -> Vec<f32> {
        let end = notes.iter().map(|n| n.1).fold(0.0, f64::max) + 0.3;
        let n = (end * sr as f64) as usize;
        let mut x = vec![0.0f32; n];
        let mut seed = 12345u64;
        for (i, v) in x.iter_mut().enumerate() {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *v = (((seed >> 33) as f64 / (1u64 << 31) as f64) - 1.0) as f32 * noise as f32;
            let _ = i;
        }
        for &(a, b, m) in notes {
            let f = 440.0 * 2f64.powf((m - 69.0 + cents / 100.0) / 12.0);
            let (ia, ib) = ((a * sr as f64) as usize, (b * sr as f64) as usize);
            let mut ph = 0.0f64;
            for i in ia..ib.min(n) {
                let t = (i - ia) as f64 / sr as f64;
                let fi = f * 2f64.powf(vib / 1200.0 * (2.0 * PI * 5.5 * t).sin());
                ph += 2.0 * PI * fi / sr as f64;
                let env = (t / 0.01).min(1.0) * ((b - a - t) / 0.02).clamp(0.0, 1.0) * (-t * 1.2).exp();
                let mut s = 0.0;
                for h in 1..=8 {
                    s += (ph * h as f64).sin() / h as f64;
                }
                x[i] += (0.3 * env * s) as f32;
            }
        }
        x
    }

    fn run(x: &[f32], sr: usize, fmin: f64, fmax: f64) -> (Vec<(f64, f64, i32)>, f64) {
        let mut m = Melody::new(1, sr, fmin, fmax);
        for c in x.chunks(4096) {
            m.feed(c, c.len());
        }
        let k = m.finish(0.5, 0.06, true);
        ((0..k).map(|i| (m.notes[i * 4], m.notes[i * 4 + 1], m.notes[i * 4 + 2] as i32)).collect(), m.tuning)
    }

    fn tune() -> Vec<(f64, f64, f64)> {
        let seq = [60.0, 62.0, 64.0, 65.0, 67.0, 67.0, 69.0, 72.0, 71.0, 67.0, 64.0, 60.0];
        seq.iter().enumerate().map(|(i, &m)| (0.2 + i as f64 * 0.32, 0.2 + i as f64 * 0.32 + 0.28, m)).collect()
    }

    fn compare(want: &[(f64, f64, f64)], got: &[(f64, f64, i32)]) {
        assert_eq!(got.len(), want.len(), "{:?}", got);
        for (w, g) in want.iter().zip(got) {
            assert_eq!(g.2, w.2 as i32, "{:?} vs {:?}", w, g);
            assert!((g.0 - w.0).abs() < 0.03, "onset {:?} vs {:?}", w, g);
            assert!((g.1 - w.1).abs() < 0.06, "end {:?} vs {:?}", w, g);
        }
    }

    #[test]
    fn melody_with_vibrato_at_several_rates() {
        let want = tune();
        for sr in [44100, 48000, 96000] {
            let x = synth(sr, &want, 0.0, 30.0, 0.003);
            let (got, tuning) = run(&x, sr, 65.0, 1050.0);
            compare(&want, &got);
            assert!(tuning.abs() < 0.05, "tuning {}", tuning);
        }
    }

    #[test]
    fn detuned_vinyl_still_gives_the_right_notes() {
        let want = tune();
        let x = synth(44100, &want, 35.0, 20.0, 0.003);
        let (got, tuning) = run(&x, 44100, 65.0, 1050.0);
        compare(&want, &got);
        assert!((tuning - 0.35).abs() < 0.05, "tuning {}", tuning);
    }

    #[test]
    fn bass_line_lands_in_the_right_octave() {
        let seq = [28.0, 28.0, 31.0, 33.0, 35.0, 33.0, 31.0, 40.0];
        let want: Vec<(f64, f64, f64)> = seq.iter().enumerate().map(|(i, &m)| (0.2 + i as f64 * 0.4, 0.2 + i as f64 * 0.4 + 0.34, m)).collect();
        let x = synth(44100, &want, 0.0, 0.0, 0.002);
        let (got, _) = run(&x, 44100, 38.0, 420.0);
        compare(&want, &got);
    }

    fn glide(sr: usize, seq: &[f64], dur: f64, pad: f64) -> Vec<f32> {
        let n = ((seq.len() as f64 * dur + 0.5) * sr as f64) as usize;
        let mut x = vec![0.0f32; n];
        let mut ph = 0.0f64;
        let (pa, pb) = (2.0 * PI * 220.0 * 2f64.powf(-5.0 / 12.0), 2.0 * PI * 220.0 * 2f64.powf(-1.0 / 12.0));
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f64 / sr as f64 - 0.2;
            let k = (t / dur).floor();
            let mut s = pad * (((i as f64 / sr as f64) * pa).sin() + ((i as f64 / sr as f64) * pb).sin());
            if t >= 0.0 && (k as usize) < seq.len() {
                let k = k as usize;
                let frac = t - k as f64 * dur;
                let m = if frac < 0.02 && k > 0 { seq[k - 1] + (seq[k] - seq[k - 1]) * frac / 0.02 } else { seq[k] };
                ph += 2.0 * PI * 440.0 * 2f64.powf((m - 69.0) / 12.0) / sr as f64;
                for h in 1..=6 {
                    s += 0.3 * (ph * h as f64).sin() / h as f64;
                }
            }
            *v = s as f32;
        }
        x
    }

    #[test]
    fn slurred_notes_without_gaps_split_at_each_pitch() {
        let seq = [64.0, 66.0, 68.0, 69.0, 71.0, 69.0, 68.0, 66.0];
        let x = glide(44100, &seq, 0.25, 0.0);
        let (got, _) = run(&x, 44100, 65.0, 1050.0);
        let ps: Vec<i32> = got.iter().map(|g| g.2).collect();
        assert_eq!(ps, seq.iter().map(|&m| m as i32).collect::<Vec<_>>(), "{:?}", got);
        for (i, g) in got.iter().enumerate() {
            assert!((g.0 - (0.2 + i as f64 * 0.25)).abs() < 0.04, "{:?}", got);
        }
    }

    #[test]
    fn melody_over_a_quieter_pad() {
        let seq = [72.0, 74.0, 76.0, 77.0, 76.0, 74.0, 72.0];
        let x = glide(44100, &seq, 0.3, 0.06);
        let (got, _) = run(&x, 44100, 65.0, 1050.0);
        let ps: Vec<i32> = got.iter().map(|g| g.2).collect();
        assert_eq!(ps, seq.iter().map(|&m| m as i32).collect::<Vec<_>>(), "{:?}", got);
    }

    #[test]
    fn ten_minutes_track_in_reasonable_time() {
        let want = tune();
        let one = synth(44100, &want, 0.0, 25.0, 0.003);
        let mut x = Vec::with_capacity(one.len() * 150);
        while x.len() < 44100 * 600 {
            x.extend_from_slice(&one);
        }
        let t = std::time::Instant::now();
        let mut m = Melody::new(2, 44100, 65.0, 1050.0);
        let mut st = vec![0.0f32; 8192];
        for c in x.chunks(4096) {
            st[..c.len()].copy_from_slice(c);
            st[c.len()..2 * c.len()].copy_from_slice(c);
            m.feed(&st[..2 * c.len()], c.len());
        }
        let k = m.finish(0.5, 0.06, true);
        let el = t.elapsed().as_secs_f64();
        println!("10 min: {} notes in {:.2} s, {} frames", k, el, m.frames());
        assert!(el < 20.0);
        assert!(k > 1500, "{}", k);
    }

    #[test]
    fn octave_below_in_the_backing_does_not_split_a_note() {
        let want: Vec<(f64, f64, f64)> = [64.0, 66.0, 64.0, 69.0].iter().enumerate().map(|(i, &m)| (0.3 + i as f64 * 0.5, 0.3 + i as f64 * 0.5 + 0.44, m)).collect();
        let mut x = synth(44100, &want, 0.0, 20.0, 0.003);
        for (i, v) in x.iter_mut().enumerate() {
            let t = i as f64 / 44100.0;
            *v += (0.05 * (2.0 * PI * 164.8138 * t).sin() + 0.05 * (2.0 * PI * 110.0 * t).sin()) as f32;
        }
        let (got, _) = run(&x, 44100, 63.5, 1076.0);
        let ps: Vec<i32> = got.iter().map(|g| g.2).collect();
        assert_eq!(ps, vec![64, 66, 64, 69], "{:?}", got);
    }

    #[test]
    fn melody_file_from_env() {
        let Ok(path) = std::env::var("STUDIO_MD_FILE") else { return; };
        let b = std::fs::read(&path).unwrap();
        let pcm: Vec<f32> = b[44..].chunks(2).map(|c| i16::from_le_bytes([c[0], c[1]]) as f32 / 32768.0).collect();
        let m = pcm.len() / 2;
        let mut planar = vec![0.0f32; pcm.len()];
        for i in 0..m {
            planar[i] = pcm[2 * i];
            planar[m + i] = pcm[2 * i + 1];
        }
        let mut t = Melody::new(2, 44100, 63.5, 1076.0);
        t.feed(&planar, m);
        let k = t.finish(0.5, 0.06, true);
        let got: Vec<(f64, f64, i32)> = (0..k).map(|i| ((t.notes[i * 4] * 1000.0).round() / 1000.0, (t.notes[i * 4 + 1] * 1000.0).round() / 1000.0, t.notes[i * 4 + 2] as i32)).collect();
        println!("tuning {:.1} cents notes {:?}", t.tuning * 100.0, got);
    }

    #[test]
    fn noise_and_silence_give_no_notes() {
        let sr = 44100;
        let mut x = vec![0.0f32; sr * 2];
        let mut seed = 7u64;
        for v in x.iter_mut().skip(sr) {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
            *v = (((seed >> 33) as f64 / (1u64 << 31) as f64) - 1.0) as f32 * 0.2;
        }
        let (got, _) = run(&x, sr, 65.0, 1050.0);
        assert!(got.len() <= 1, "{:?}", got);
    }
}


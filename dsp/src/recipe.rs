use crate::enc::Flac;
use crate::fx::Rack;
use crate::loud::{Limiter, Meter, Stats};
use crate::rs::Rs;
use crate::stretch::Stretch;
use crate::Decoder;
use symphonia::core::io::MediaSource;

pub struct Audio {
    pub sr: usize,
    pub data: Vec<Vec<f32>>,
}

impl Audio {
    pub fn ch(&self) -> usize {
        self.data.len()
    }

    pub fn len(&self) -> usize {
        self.data.first().map(|d| d.len()).unwrap_or(0)
    }

    pub fn is_empty(&self) -> bool {
        self.len() == 0
    }
}

pub enum Step {
    Rack(Vec<f64>),
    Loud { target: f64, ceil: f64 },
    Norm { peak: f64 },
    Dc,
    Mono,
    Stretch { speed: f64, semis: f64 },
}

pub fn decode(source: Box<dyn MediaSource>, ext: &str, max_frames: usize) -> Result<Audio, String> {
    let mut d = Decoder::open(source, ext)?;
    let ch = d.channels as usize;
    let mut data = vec![Vec::new(); ch];
    loop {
        let n = d.next()?;
        if n == 0 {
            break;
        }
        let p = d.planar();
        for c in 0..ch {
            data[c].extend_from_slice(&p[c * n..(c + 1) * n]);
        }
        if data[0].len() > max_frames {
            return Err("file too long".into());
        }
    }
    if data.is_empty() || data[0].is_empty() {
        return Err("no audio".into());
    }
    Ok(Audio { sr: d.sample_rate as usize, data })
}

const BLK: usize = 16384;

fn stream<F>(a: &Audio, mut f: F) -> Result<Vec<Vec<f32>>, String>
where
    F: FnMut(&[Vec<f32>], usize, usize) -> Result<(Vec<f32>, usize), String>,
{
    let (ch, n) = (a.ch(), a.len());
    let mut out = vec![Vec::with_capacity(n); ch];
    let mut pos = 0;
    while out[0].len() < n {
        let (y, made) = f(&a.data, pos, BLK)?;
        pos += BLK;
        for c in 0..ch {
            let take = made.min(n - out[c].len());
            out[c].extend_from_slice(&y[c * made..c * made + take]);
        }
        if pos > n + 8 * BLK && out[0].len() < n {
            return Err("processing stalled".into());
        }
    }
    Ok(out)
}

fn stage(src: &[Vec<f32>], pos: usize, m: usize, dst: &mut [f32]) {
    for (c, s) in src.iter().enumerate() {
        for i in 0..m {
            dst[c * m + i] = s.get(pos + i).copied().unwrap_or(0.0);
        }
    }
}

pub fn rack(a: &mut Audio, cfg: &[f64]) -> Result<(), String> {
    let mut r = Rack::new(a.ch(), a.sr);
    r.configure(cfg)?;
    let out = stream(a, |src, pos, m| {
        r.stage(m);
        stage(src, pos, m, &mut r.inp);
        let made = r.run(m);
        Ok((r.out[..a.ch() * made].to_vec(), made))
    })?;
    a.data = out;
    Ok(())
}

pub fn measure(a: &Audio) -> Stats {
    let (ch, n) = (a.ch(), a.len());
    let mut m = Meter::new(ch, a.sr);
    let mut buf = vec![0.0f32; ch * BLK];
    let mut pos = 0;
    while pos < n {
        let k = BLK.min(n - pos);
        stage(&a.data, pos, k, &mut buf[..ch * k]);
        m.feed(&buf[..ch * k], k);
        pos += k;
    }
    m.stats()
}

fn limited(a: &Audio, gain: f64, ceil: f64) -> Result<Audio, String> {
    let mut l = Limiter::new(a.ch(), a.sr);
    l.configure(gain, ceil, 2.0, 15.0, true);
    let ch = a.ch();
    let data = stream(a, |src, pos, m| {
        l.stage(m);
        stage(src, pos, m, &mut l.stage);
        let made = l.run(m);
        Ok((l.out[..ch * made].to_vec(), made))
    })?;
    Ok(Audio { sr: a.sr, data })
}

pub fn loud(a: &mut Audio, target: f64, ceil: f64) -> Result<Option<f64>, String> {
    let lin = measure(a).integrated;
    if !lin.is_finite() {
        return Ok(None);
    }
    let mut gain = target - lin;
    let mut prev: Option<(f64, f64)> = None;
    let mut best: Option<(f64, Audio)> = None;
    for _ in 0..7 {
        let y = limited(a, gain, ceil)?;
        let out = measure(&y).integrated;
        if !out.is_finite() {
            break;
        }
        let near = (out - target).abs() < 0.05;
        best = Some((out, y));
        if near {
            break;
        }
        let slope = match prev {
            Some((g, o)) if (gain - g).abs() > 1e-3 => ((out - o) / (gain - g)).clamp(0.05, 1.0),
            _ => 1.0,
        };
        if prev.is_some() && slope < 0.08 && out < target - 0.3 {
            break;
        }
        prev = Some((gain, out));
        let next = (gain + ((target - out) / slope).min(12.0)).min(36.0);
        if (next - gain).abs() < 0.01 {
            break;
        }
        gain = next;
    }
    match best {
        Some((out, y)) => {
            a.data = y.data;
            Ok(Some(out))
        }
        None => Ok(None),
    }
}

pub fn norm(a: &mut Audio, peak: f64) -> Option<f64> {
    let st = measure(a);
    let pk = st.tp.iter().copied().fold(0.0f32, f32::max) as f64;
    if pk <= 0.0 {
        return None;
    }
    let g = (10f64.powf(peak / 20.0) / pk) as f32;
    for d in a.data.iter_mut() {
        d.iter_mut().for_each(|v| *v *= g);
    }
    Some(20.0 * (g as f64).log10())
}

pub fn dc(a: &mut Audio) {
    for d in a.data.iter_mut() {
        let m = (d.iter().map(|v| *v as f64).sum::<f64>() / d.len().max(1) as f64) as f32;
        d.iter_mut().for_each(|v| *v -= m);
    }
}

pub fn mono(a: &mut Audio) -> bool {
    if a.ch() != 2 {
        return false;
    }
    let n = a.len();
    for i in 0..n {
        let m = (a.data[0][i] + a.data[1][i]) * 0.5;
        a.data[0][i] = m;
        a.data[1][i] = m;
    }
    true
}

pub fn stretch(a: &mut Audio, speed: f64, semis: f64) -> Result<bool, String> {
    let pitch = 2f64.powf(semis / 12.0);
    if (speed - 1.0).abs() < 1e-6 && semis.abs() < 1e-6 {
        return Ok(false);
    }
    let (ch, n) = (a.ch(), a.len());
    let total = ((n as f64) / speed).round() as usize;
    let mut s = Stretch::new(ch);
    s.begin(0.0, speed, pitch);
    let mut fed = s.first();
    let mut out = vec![Vec::with_capacity(total); ch];
    while out[0].len() < total {
        if s.need_end() > s.have_end() {
            s.stage_in(BLK);
            for c in 0..ch {
                for i in 0..BLK {
                    let p = fed + i as i64;
                    s.stage[c * BLK + i] = if p >= 0 && (p as usize) < n { a.data[c][p as usize] } else { 0.0 };
                }
            }
            s.push(BLK);
            fed += BLK as i64;
            continue;
        }
        let want = (total - out[0].len()).min(BLK);
        let got = s.run(want);
        for c in 0..ch {
            out[c].extend_from_slice(&s.out[c * got..(c + 1) * got]);
        }
    }
    a.data = out;
    Ok(true)
}

pub fn resample(a: &mut Audio, rate: usize) -> Result<(), String> {
    if rate == 0 || rate == a.sr {
        return Ok(());
    }
    let (ch, n) = (a.ch(), a.len());
    let mut r = Rs::new(a.sr, rate, ch)?;
    let delay = r.delay();
    let total = ((n as f64) * rate as f64 / a.sr as f64).ceil() as usize;
    let mut out = vec![Vec::with_capacity(total + 16); ch];
    let mut pos = 0;
    let mut skip = delay;
    let istr = r.in_stride();
    let ostr = r.out_stride();
    while out[0].len() < total {
        let need = r.input_frames();
        for c in 0..ch {
            for i in 0..need {
                r.inp[c * istr + i] = a.data[c].get(pos + i).copied().unwrap_or(0.0);
            }
        }
        pos += need;
        let made = r.process(need)?;
        let from = skip.min(made);
        skip -= from;
        for c in 0..ch {
            let take = (made - from).min(total - out[c].len());
            out[c].extend_from_slice(&r.out[c * ostr + from..c * ostr + from + take]);
        }
        if pos > n + delay + 1_000_000 {
            return Err("resampler stalled".into());
        }
    }
    a.data = out;
    a.sr = rate;
    Ok(())
}

pub fn run(a: &mut Audio, steps: &[Step]) -> Result<Vec<String>, String> {
    let mut notes = Vec::new();
    for s in steps {
        match s {
            Step::Rack(c) => rack(a, c)?,
            Step::Loud { target, ceil } => match loud(a, *target, *ceil)? {
                Some(v) => notes.push(format!("loudness {:.1} LUFS", v)),
                None => notes.push("silent, loudness skipped".into()),
            },
            Step::Norm { peak } => {
                if norm(a, *peak).is_none() {
                    notes.push("silent, normalize skipped".into());
                }
            }
            Step::Dc => dc(a),
            Step::Mono => {
                mono(a);
            }
            Step::Stretch { speed, semis } => {
                stretch(a, *speed, *semis)?;
            }
        }
    }
    Ok(notes)
}

struct Dither(u32);

impl Dither {
    fn next(&mut self) -> f64 {
        let mut x = self.0;
        x ^= x << 13;
        x ^= x >> 17;
        x ^= x << 5;
        self.0 = x;
        x as f64 / u32::MAX as f64
    }

    fn tpdf(&mut self) -> f64 {
        self.next() - self.next()
    }
}

fn quantize(v: f32, bits: usize, d: &mut Dither) -> i32 {
    let full = (1i64 << (bits - 1)) as f64;
    let q = (v as f64 * full + d.tpdf()).round();
    q.clamp(-full, full - 1.0) as i32
}

pub fn wav(a: &Audio, bits: usize) -> Result<Vec<u8>, String> {
    let (ch, n) = (a.ch(), a.len());
    let float = bits == 32;
    let bps = bits / 8;
    let data = (n * ch * bps) as u64;
    if data + 80 > u32::MAX as u64 {
        return Err("file too large for WAV".into());
    }
    let fmt_len: u32 = if float { 18 } else { 16 };
    let fact = if float { 12 } else { 0 };
    let mut o = Vec::with_capacity(data as usize + 80);
    let riff = 4 + 8 + fmt_len + fact + 8 + data as u32 + (data as u32 & 1);
    o.extend_from_slice(b"RIFF");
    o.extend_from_slice(&riff.to_le_bytes());
    o.extend_from_slice(b"WAVEfmt ");
    o.extend_from_slice(&fmt_len.to_le_bytes());
    o.extend_from_slice(&(if float { 3u16 } else { 1u16 }).to_le_bytes());
    o.extend_from_slice(&(ch as u16).to_le_bytes());
    o.extend_from_slice(&(a.sr as u32).to_le_bytes());
    o.extend_from_slice(&((a.sr * ch * bps) as u32).to_le_bytes());
    o.extend_from_slice(&((ch * bps) as u16).to_le_bytes());
    o.extend_from_slice(&(bits as u16).to_le_bytes());
    if float {
        o.extend_from_slice(&0u16.to_le_bytes());
        o.extend_from_slice(b"fact");
        o.extend_from_slice(&4u32.to_le_bytes());
        o.extend_from_slice(&(n as u32).to_le_bytes());
    }
    o.extend_from_slice(b"data");
    o.extend_from_slice(&(data as u32).to_le_bytes());
    let mut d = Dither(0x9e37_79b9);
    for i in 0..n {
        for c in 0..ch {
            let v = a.data[c][i];
            match bits {
                32 => o.extend_from_slice(&v.to_le_bytes()),
                24 => o.extend_from_slice(&quantize(v, 24, &mut d).to_le_bytes()[..3]),
                _ => o.extend_from_slice(&(quantize(v, 16, &mut d) as i16).to_le_bytes()),
            }
        }
    }
    if data & 1 == 1 {
        o.push(0);
    }
    Ok(o)
}

pub fn flac(a: &Audio, bits: usize) -> Result<Vec<u8>, String> {
    let (ch, n) = (a.ch(), a.len());
    let block = 4096;
    let mut f = Flac::new(a.sr, ch, bits, block)?;
    let mut d = Dither(0x2545_f491);
    let mut body = Vec::new();
    let mut inter = vec![0i32; block * ch];
    let mut pos = 0;
    while pos < n {
        let k = block.min(n - pos);
        for i in 0..k {
            for c in 0..ch {
                inter[i * ch + c] = quantize(a.data[c][pos + i], bits, &mut d);
            }
        }
        body.extend_from_slice(f.frame(&inter[..k * ch])?);
        pos += k;
    }
    let mut o = f.header(true)?;
    o.extend_from_slice(&body);
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::f64::consts::TAU;
    use std::io::Cursor;

    fn tone(n: usize, sr: usize, f: f64, a: f64) -> Vec<f32> {
        (0..n).map(|i| (a * (TAU * f * i as f64 / sr as f64).sin()) as f32).collect()
    }

    fn noise(n: usize, seed: u32, amp: f32) -> Vec<f32> {
        let mut d = Dither(seed);
        (0..n).map(|_| (d.tpdf() as f32) * amp).collect()
    }

    #[test]
    fn a_flat_rack_and_no_steps_leave_the_audio_alone() {
        let sr = 48000;
        let x = tone(sr, sr, 440.0, 0.5);
        let mut a = Audio { sr, data: vec![x.clone(), x.clone()] };
        rack(&mut a, &vec![0.0; crate::fx::CFG_LEN]).unwrap();
        assert!(a.data[0] == x);
    }

    #[test]
    fn a_limiter_below_its_ceiling_keeps_the_timing() {
        let sr = 44100;
        let x = tone(sr, sr, 440.0, 0.1);
        let mut cfg = vec![0.0; crate::fx::CFG_LEN];
        cfg[13..17].copy_from_slice(&[1.0, -1.0, 2.0, 100.0]);
        let mut a = Audio { sr, data: vec![x.clone()] };
        rack(&mut a, &cfg).unwrap();
        let d = a.data[0].iter().zip(&x).map(|(p, q)| (p - q).abs()).fold(0.0f32, f32::max);
        assert!(d < 1e-4, "{d}");
        let y = limited(&Audio { sr, data: vec![x.clone()] }, 0.0, -1.0).unwrap();
        let d = y.data[0].iter().zip(&x).map(|(p, q)| (p - q).abs()).fold(0.0f32, f32::max);
        assert!(d < 1e-4, "{d}");
    }

    #[test]
    fn loudness_match_reaches_the_target_under_the_ceiling() {
        let sr = 48000;
        let n = sr * 12;
        let mut a = Audio { sr, data: vec![noise(n, 3, 0.05), noise(n, 7, 0.05)] };
        let out = loud(&mut a, -14.0, -1.0).unwrap().unwrap();
        assert!((out + 14.0).abs() < 0.3, "{out}");
        let st = measure(&a);
        assert!((st.integrated + 14.0).abs() < 0.3);
        let tp = 20.0 * (st.tp.iter().copied().fold(0.0f32, f32::max) as f64).log10();
        assert!(tp <= -0.9, "{tp}");
        assert_eq!(a.len(), n);
    }

    #[test]
    fn normalize_dc_mono_and_stretch_do_what_they_say() {
        let sr = 44100;
        let n = sr * 2;
        let mut l = tone(n, sr, 440.0, 0.25);
        l.iter_mut().for_each(|v| *v += 0.1);
        let r = tone(n, sr, 660.0, 0.25);
        let mut a = Audio { sr, data: vec![l, r] };
        dc(&mut a);
        assert!(a.data[0].iter().map(|v| *v as f64).sum::<f64>().abs() / (n as f64) < 1e-6);
        norm(&mut a, -3.0).unwrap();
        let tp = 20.0 * (measure(&a).tp.iter().copied().fold(0.0f32, f32::max) as f64).log10();
        assert!((tp + 3.0).abs() < 0.05, "{tp}");
        assert!(mono(&mut a));
        assert!(a.data[0] == a.data[1]);
        stretch(&mut a, 0.5, 0.0).unwrap();
        assert_eq!(a.len(), 2 * n);
    }

    #[test]
    fn wav_and_flac_decode_back_to_the_same_audio() {
        let sr = 48000;
        let n = sr + 123;
        let a = Audio { sr, data: vec![tone(n, sr, 1000.0, 0.5), tone(n, sr, 300.0, 0.3)] };
        for (bytes, ext, tol) in [(wav(&a, 32).unwrap(), "wav", 0.0f32), (wav(&a, 24).unwrap(), "wav", 3.0 / 8388608.0), (flac(&a, 24).unwrap(), "flac", 3.0 / 8388608.0), (flac(&a, 16).unwrap(), "flac", 3.0 / 32768.0), (wav(&a, 16).unwrap(), "wav", 3.0 / 32768.0)] {
            let b = decode(Box::new(Cursor::new(bytes)), ext, usize::MAX).unwrap();
            assert_eq!(b.len(), n, "{ext}");
            assert_eq!(b.sr, sr);
            let d = (0..n).map(|i| (b.data[0][i] - a.data[0][i]).abs().max((b.data[1][i] - a.data[1][i]).abs())).fold(0.0f32, f32::max);
            assert!(d <= tol + 1e-9, "{ext} {d}");
        }
    }

    #[test]
    fn resampling_keeps_the_length_and_the_tone() {
        let sr = 96000;
        let n = sr * 2;
        let mut a = Audio { sr, data: vec![tone(n, sr, 1000.0, 0.5)] };
        resample(&mut a, 48000).unwrap();
        assert_eq!(a.sr, 48000);
        assert_eq!(a.len(), n / 2);
        let y = &a.data[0][4800..a.len() - 4800];
        let z = (1..y.len()).filter(|&i| y[i - 1] <= 0.0 && y[i] > 0.0).count() as f64 * 48000.0 / y.len() as f64;
        assert!((z - 1000.0).abs() < 2.0, "{z}");
        let pk = y.iter().fold(0.0f32, |m, v| m.max(v.abs()));
        assert!((pk - 0.5).abs() < 0.01, "{pk}");
    }
}

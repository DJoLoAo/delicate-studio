use symphonia::core::audio::GenericAudioBufferRef;
use symphonia::core::codecs::CodecParameters;
use symphonia::core::codecs::audio::{AudioDecoder, AudioDecoderOptions};
use symphonia::core::errors::Error as SymError;
use symphonia::core::formats::probe::Hint;
use symphonia::core::formats::{FormatOptions, FormatReader};
use symphonia::core::io::{MediaSource, MediaSourceStream};
use symphonia::core::meta::MetadataOptions;

pub struct Decoder {
    format: Box<dyn FormatReader>,
    decoder: Box<dyn AudioDecoder>,
    track: u32,
    pub sample_rate: u32,
    pub channels: u32,
    pub bits: u32,
    pub frames: u64,
    inter: Vec<f32>,
    planar: Vec<f32>,
}

impl Decoder {
    pub fn open(source: Box<dyn MediaSource>, ext: &str) -> Result<Self, String> {
        let mss = MediaSourceStream::new(source, Default::default());
        let mut hint = Hint::new();
        let ext = ext.to_ascii_lowercase();
        if !ext.is_empty() {
            hint.with_extension(&ext);
        }
        let format = symphonia::default::get_probe()
            .probe(&hint, mss, FormatOptions::default(), MetadataOptions::default())
            .map_err(|e| format!("unsupported or damaged file: {e}"))?;
        let track = format
            .tracks()
            .iter()
            .find(|t| matches!(t.codec_params, Some(CodecParameters::Audio(_))))
            .ok_or_else(|| "no audio track".to_string())?;
        let track_id = track.id;
        let frames = track.num_frames.unwrap_or(0);
        let Some(CodecParameters::Audio(params)) = track.codec_params.clone() else {
            return Err("no audio track".into());
        };
        let sample_rate = params.sample_rate.ok_or_else(|| "unknown sample rate".to_string())?;
        let channels = params.channels.as_ref().map(|c| c.count() as u32).ok_or_else(|| "unknown channel layout".to_string())?;
        let bits = params.bits_per_sample.unwrap_or(0);
        let decoder = symphonia::default::get_codecs()
            .make_audio_decoder(&params, &AudioDecoderOptions::default())
            .map_err(|e| format!("unsupported codec: {e}"))?;
        Ok(Decoder { format, decoder, track: track_id, sample_rate, channels, bits, frames, inter: Vec::new(), planar: Vec::new() })
    }

    pub fn next(&mut self) -> Result<usize, String> {
        loop {
            let packet = match self.format.next_packet() {
                Ok(Some(p)) => p,
                Ok(None) => return Ok(0),
                Err(e) => return Err(format!("read error: {e}")),
            };
            if packet.track_id != self.track {
                continue;
            }
            let buf: GenericAudioBufferRef = match self.decoder.decode(&packet) {
                Ok(b) => b,
                Err(SymError::DecodeError(_)) => continue,
                Err(e) => return Err(format!("decode error: {e}")),
            };
            let n = buf.frames();
            if n == 0 {
                continue;
            }
            let ch = buf.spec().channels().count();
            self.inter.resize(n * ch, 0.0);
            buf.copy_to_slice_interleaved(&mut self.inter);
            let out_ch = self.channels as usize;
            self.planar.resize(n * out_ch, 0.0);
            for c in 0..out_ch {
                let src = c.min(ch - 1);
                for (i, v) in self.planar[c * n..(c + 1) * n].iter_mut().enumerate() {
                    *v = self.inter[i * ch + src];
                }
            }
            return Ok(n);
        }
    }

    pub fn planar(&self) -> &[f32] {
        &self.planar
    }
}

pub mod enc;
pub mod hum;
pub mod nr;
pub mod restore;
pub mod rs;

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::Decoder;
    use sha2::{Digest, Sha256};
    use std::io::{Read, Result as IoResult, Seek, SeekFrom};
    use symphonia::core::io::MediaSource;

    #[link(wasm_import_module = "env")]
    unsafe extern "C" {
        fn read_at(pos: f64, ptr: *mut u8, len: u32) -> u32;
        fn byte_len() -> f64;
    }

    struct JsSource {
        pos: u64,
        len: u64,
    }

    impl Read for JsSource {
        fn read(&mut self, buf: &mut [u8]) -> IoResult<usize> {
            if self.pos >= self.len || buf.is_empty() {
                return Ok(0);
            }
            let want = buf.len().min((self.len - self.pos) as usize).min(u32::MAX as usize);
            let n = unsafe { read_at(self.pos as f64, buf.as_mut_ptr(), want as u32) } as usize;
            self.pos += n as u64;
            Ok(n)
        }
    }

    impl Seek for JsSource {
        fn seek(&mut self, from: SeekFrom) -> IoResult<u64> {
            let next = match from {
                SeekFrom::Start(p) => p as i128,
                SeekFrom::Current(d) => self.pos as i128 + d as i128,
                SeekFrom::End(d) => self.len as i128 + d as i128,
            };
            if next < 0 {
                return Err(std::io::Error::other("seek before start"));
            }
            self.pos = next as u64;
            Ok(self.pos)
        }
    }

    impl MediaSource for JsSource {
        fn is_seekable(&self) -> bool {
            true
        }
        fn byte_len(&self) -> Option<u64> {
            Some(self.len)
        }
    }

    static mut DEC: Option<Decoder> = None;
    static mut ERROR: String = String::new();

    fn dec() -> Option<&'static mut Decoder> {
        unsafe { (*std::ptr::addr_of_mut!(DEC)).as_mut() }
    }

    fn fail(msg: String) -> i32 {
        unsafe { *std::ptr::addr_of_mut!(ERROR) = msg; }
        -1
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn mem_alloc(len: usize) -> *mut u8 {
        let mut v: Vec<u8> = Vec::with_capacity(len.max(1));
        let p = v.as_mut_ptr();
        std::mem::forget(v);
        p
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn mem_free(ptr: *mut u8, len: usize) {
        unsafe { drop(Vec::from_raw_parts(ptr, 0, len.max(1))); }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_open(ext_ptr: *const u8, ext_len: usize) -> i32 {
        dec_close();
        let ext = unsafe { std::str::from_utf8(std::slice::from_raw_parts(ext_ptr, ext_len)).unwrap_or("") };
        let len = unsafe { byte_len() } as u64;
        match Decoder::open(Box::new(JsSource { pos: 0, len }), ext) {
            Ok(d) => {
                unsafe { *std::ptr::addr_of_mut!(DEC) = Some(d); }
                0
            }
            Err(e) => fail(e),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_sample_rate() -> u32 {
        dec().map(|d| d.sample_rate).unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_channels() -> u32 {
        dec().map(|d| d.channels).unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_bits() -> u32 {
        dec().map(|d| d.bits).unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_frames() -> f64 {
        dec().map(|d| d.frames as f64).unwrap_or(0.0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_next() -> i32 {
        let Some(d) = dec() else { return fail("decoder not open".into()); };
        match d.next() {
            Ok(n) => n as i32,
            Err(e) => fail(e),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_buf() -> *const f32 {
        dec().map(|d| d.planar().as_ptr()).unwrap_or(std::ptr::null())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_error_ptr() -> *const u8 {
        unsafe { (&*std::ptr::addr_of!(ERROR)).as_ptr() }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_error_len() -> usize {
        unsafe { (&*std::ptr::addr_of!(ERROR)).len() }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dec_close() {
        unsafe { *std::ptr::addr_of_mut!(DEC) = None; }
    }

    static mut FLAC: Option<crate::enc::Flac> = None;
    static mut FL_IN: Vec<i32> = Vec::new();
    static mut FL_OUT: (usize, usize) = (0, 0);
    static mut FL_HDR: Vec<u8> = Vec::new();

    fn flac() -> Option<&'static mut crate::enc::Flac> {
        unsafe { (*std::ptr::addr_of_mut!(FLAC)).as_mut() }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn fl_open(rate: u32, channels: u32, bits: u32, block: u32) -> i32 {
        match crate::enc::Flac::new(rate as usize, channels as usize, bits as usize, block as usize) {
            Ok(f) => unsafe {
                *std::ptr::addr_of_mut!(FLAC) = Some(f);
                *std::ptr::addr_of_mut!(FL_IN) = vec![0; (block * channels) as usize];
                0
            },
            Err(e) => fail(e),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn fl_in() -> *mut i32 {
        unsafe { (*std::ptr::addr_of_mut!(FL_IN)).as_mut_ptr() }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn fl_frame(samples: u32) -> i32 {
        let Some(f) = flac() else { return fail("flac not open".into()); };
        let input = unsafe { &(&*std::ptr::addr_of!(FL_IN))[..samples as usize] };
        match f.frame(input) {
            Ok(b) => unsafe {
                *std::ptr::addr_of_mut!(FL_OUT) = (b.as_ptr() as usize, b.len());
                b.len() as i32
            },
            Err(e) => fail(e),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn fl_header(last: u32) -> i32 {
        let Some(f) = flac() else { return fail("flac not open".into()); };
        match f.header(last != 0) {
            Ok(h) => unsafe {
                let hdr = &mut *std::ptr::addr_of_mut!(FL_HDR);
                *hdr = h;
                *std::ptr::addr_of_mut!(FL_OUT) = (hdr.as_ptr() as usize, hdr.len());
                hdr.len() as i32
            },
            Err(e) => fail(e),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn fl_out() -> *const u8 {
        unsafe { (*std::ptr::addr_of!(FL_OUT)).0 as *const u8 }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn fl_close() {
        unsafe {
            *std::ptr::addr_of_mut!(FLAC) = None;
            *std::ptr::addr_of_mut!(FL_IN) = Vec::new();
        }
    }

    static mut RP_BUF: Vec<f32> = Vec::new();
    static mut RP_MASK: Vec<u8> = Vec::new();
    static mut RP_OUT: Vec<f32> = Vec::new();

    #[unsafe(no_mangle)]
    pub extern "C" fn rp_buf(n: u32) -> *mut f32 {
        unsafe {
            let b = &mut *std::ptr::addr_of_mut!(RP_BUF);
            if b.len() < n as usize {
                b.resize(n as usize, 0.0);
            }
            let m = &mut *std::ptr::addr_of_mut!(RP_MASK);
            if m.len() < n as usize {
                m.resize(n as usize, 0);
            }
            b.as_mut_ptr()
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rp_mask() -> *mut u8 {
        unsafe { (*std::ptr::addr_of_mut!(RP_MASK)).as_mut_ptr() }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dc_scan(n: u32, sr: u32, sens: f32, max_ms: f32) -> i32 {
        let x = unsafe { &(&*std::ptr::addr_of!(RP_BUF))[..n as usize] };
        let d = crate::restore::Detect::for_rate(sr as usize, sens as f64, max_ms as f64);
        let mut found = Vec::new();
        crate::restore::detect(x, &d, &mut found);
        let out = unsafe { &mut *std::ptr::addr_of_mut!(RP_OUT) };
        out.clear();
        for c in &found {
            out.extend_from_slice(&[c.start as f32, c.end as f32, c.strength, c.two]);
        }
        found.len() as i32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dc_out() -> *const f32 {
        unsafe { (*std::ptr::addr_of!(RP_OUT)).as_ptr() }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rp_fill(n: u32, p: u32, seed: u32) -> i32 {
        let n = n as usize;
        let mask: Vec<bool> = unsafe { (&*std::ptr::addr_of!(RP_MASK))[..n].iter().map(|&v| v != 0).collect() };
        let x = unsafe { &mut (&mut *std::ptr::addr_of_mut!(RP_BUF))[..n] };
        let ok = if seed == 0 { crate::restore::fill(x, &mask, p as usize) } else { crate::restore::fill_textured(x, &mask, p as usize, seed as u64) };
        if ok { 0 } else { fail("repair could not be computed here".into()) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rp_order(sr: u32, m: u32, heal: u32) -> u32 {
        if heal != 0 { crate::restore::heal_order(sr as usize, m as usize) as u32 } else { crate::restore::repair_order(sr as usize) as u32 }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rp_context(p: u32, m: u32, heal: u32) -> u32 {
        crate::restore::context_len(p as usize, m as usize, heal != 0) as u32
    }

    static mut NR: [Option<crate::nr::Nr>; 2] = [None, None];
    static mut NP_BUF: Vec<f32> = Vec::new();
    static mut NP_OUT: Vec<f32> = Vec::new();

    fn nrm(slot: u32) -> Option<&'static mut crate::nr::Nr> {
        unsafe { (*std::ptr::addr_of_mut!(NR)).get_mut(slot as usize).and_then(|s| s.as_mut()) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_open(slot: u32, ch: u32, sr: u32, n: u32, k: u32) -> i32 {
        if slot > 1 || ch == 0 || ch > 8 || sr == 0 || !(256..=65536).contains(&n) || !n.is_power_of_two() || !(3..=32).contains(&k) {
            return fail("noise reduction settings out of range".into());
        }
        unsafe { (*std::ptr::addr_of_mut!(NR))[slot as usize] = Some(crate::nr::Nr::new(ch as usize, sr as usize, n as usize, k as usize)); }
        0
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_close(slot: u32) {
        if slot <= 1 {
            unsafe { (*std::ptr::addr_of_mut!(NR))[slot as usize] = None; }
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_print(slot: u32, c: u32) -> *mut f32 {
        match nrm(slot) {
            Some(r) if (c as usize) < r.ch => r.gn.print_mut(c as usize).as_mut_ptr(),
            _ => std::ptr::null_mut(),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_curve(slot: u32) -> *mut f32 {
        nrm(slot).map(|r| r.gn.curve.as_mut_ptr()).unwrap_or(std::ptr::null_mut())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_set(slot: u32, floor: f32, amount: f32, thr: f32, decay: f32, link: u32, only: u32) -> i32 {
        let Some(r) = nrm(slot) else { return fail("noise reduction is not open".into()) };
        r.gn.configure(crate::nr::Settings { floor_db: floor, amount, thr_db: thr, decay, link: link != 0, noise_only: only != 0 });
        0
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_reset(slot: u32) {
        if let Some(r) = nrm(slot) {
            r.reset();
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_hop(slot: u32) -> u32 {
        nrm(slot).map(|r| r.st.hop as u32).unwrap_or(0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_in(slot: u32, m: u32) -> *mut f32 {
        nrm(slot).map(|r| r.stage(m as usize)).unwrap_or(std::ptr::null_mut())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_run(slot: u32, m: u32) -> i32 {
        match nrm(slot) {
            Some(r) => r.run(m as usize) as i32,
            None => fail("noise reduction is not open".into()),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn nr_out(slot: u32) -> *const f32 {
        nrm(slot).map(|r| r.out.as_ptr()).unwrap_or(std::ptr::null())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn np_buf(len: u32) -> *mut f32 {
        unsafe {
            let b = &mut *std::ptr::addr_of_mut!(NP_BUF);
            if b.len() < len as usize {
                b.resize(len as usize, 0.0);
            }
            b.as_mut_ptr()
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn np_stats(len: u32, n: u32, k: u32) -> i32 {
        if !(256..=65536).contains(&n) || !n.is_power_of_two() || !(3..=32).contains(&k) {
            return fail("noise print settings out of range".into());
        }
        let x = unsafe { &(&*std::ptr::addr_of!(NP_BUF))[..len as usize] };
        let Some(p) = crate::nr::print_of(x, n as usize, k as usize) else { return fail("the noise print is too short".into()) };
        let out = unsafe { &mut *std::ptr::addr_of_mut!(NP_OUT) };
        out.clear();
        out.extend_from_slice(&p.mean);
        out.extend_from_slice(&p.lo);
        out.extend_from_slice(&p.hi);
        p.frames as i32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn np_out() -> *const f32 {
        unsafe { (*std::ptr::addr_of!(NP_OUT)).as_ptr() }
    }

    static mut DH: [Option<crate::hum::Hum>; 3] = [None, None, None];
    static mut DH_OUT: Vec<f32> = Vec::new();

    fn dhm(slot: u32) -> Option<&'static mut crate::hum::Hum> {
        unsafe { (*std::ptr::addr_of_mut!(DH)).get_mut(slot as usize).and_then(|s| s.as_mut()) }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_open(slot: u32, ch: u32, sr: u32) -> i32 {
        if slot > 2 || ch == 0 || ch > 8 || sr == 0 {
            return fail("dehummer settings out of range".into());
        }
        unsafe { (*std::ptr::addr_of_mut!(DH))[slot as usize] = Some(crate::hum::Hum::new(ch as usize, sr as usize)); }
        0
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_set(slot: u32, f0: f64, n: u32, q: f64, gain: f64, slope: f64, only: u32) -> i32 {
        let Some(h) = dhm(slot) else { return fail("dehummer is not open".into()) };
        h.configure(f0, n as usize, q, gain, slope, only != 0);
        h.filters() as i32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_reset(slot: u32) {
        if let Some(h) = dhm(slot) {
            h.reset();
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_in(slot: u32, m: u32) -> *mut f32 {
        dhm(slot).map(|h| h.stage(m as usize)).unwrap_or(std::ptr::null_mut())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_run(slot: u32, m: u32) -> i32 {
        match dhm(slot) {
            Some(h) => h.run(m as usize) as i32,
            None => fail("dehummer is not open".into()),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_out(slot: u32) -> *const f32 {
        dhm(slot).map(|h| h.out.as_ptr()).unwrap_or(std::ptr::null())
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_resp(slot: u32, f: f64) -> f64 {
        dhm(slot).map(|h| h.response(f)).unwrap_or(0.0)
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_find(len: u32, sr: u32, center: f64) -> i32 {
        let x = unsafe { &(&*std::ptr::addr_of!(NP_BUF))[..len as usize] };
        let pick = |c: f64| crate::hum::find(x, sr as usize, c - 0.8, c + 0.8);
        let found = if center > 0.0 {
            pick(center)
        } else {
            match (pick(50.0), pick(60.0)) {
                (Some(a), Some(b)) => Some(if a.harmonics > 0 && (b.harmonics == 0 || a.score >= b.score) { a } else if b.harmonics > 0 { b } else if a.score >= b.score { a } else { b }),
                (a, b) => a.or(b),
            }
        };
        let Some(f) = found else { return fail("not enough audio to look for hum".into()) };
        let out = unsafe { &mut *std::ptr::addr_of_mut!(DH_OUT) };
        out.clear();
        out.extend_from_slice(&[f.f0 as f32, f.score as f32, f.harmonics as f32, f.bin as f32]);
        out.extend_from_slice(&f.prom);
        out.extend_from_slice(&f.spec);
        out.len() as i32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_found() -> *const f32 {
        unsafe { (*std::ptr::addr_of!(DH_OUT)).as_ptr() }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn dh_f0() -> f64 {
        unsafe { (*std::ptr::addr_of!(DH_OUT)).first().copied().unwrap_or(0.0) as f64 }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn cl_runs(n: u32, top: f32, bot: f32, tol: f32, min_run: u32) -> i32 {
        let x = unsafe { &(&*std::ptr::addr_of!(RP_BUF))[..n as usize] };
        let mut runs = Vec::new();
        crate::restore::clip_runs(x, top, bot, tol, min_run as usize, &mut runs);
        let out = unsafe { &mut *std::ptr::addr_of_mut!(RP_OUT) };
        out.clear();
        for r in &runs {
            out.extend_from_slice(&[r.start as f32, r.end as f32, 0.0, 0.0]);
        }
        runs.len() as i32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn cl_order(sr: u32) -> u32 {
        crate::restore::declip_order(sr as usize) as u32
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn cl_fill(n: u32, p: u32) -> i32 {
        let n = n as usize;
        let mask: Vec<bool> = unsafe { (&*std::ptr::addr_of!(RP_MASK))[..n].iter().map(|&v| v != 0).collect() };
        let x = unsafe { &mut (&mut *std::ptr::addr_of_mut!(RP_BUF))[..n] };
        if crate::restore::declip(x, &mask, p as usize) { 0 } else { fail("clipping could not be repaired here".into()) }
    }

    static mut RS: Option<crate::rs::Rs> = None;

    fn rsm() -> Option<&'static mut crate::rs::Rs> {
        unsafe { (*std::ptr::addr_of_mut!(RS)).as_mut() }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rs_open(rate_in: u32, rate_out: u32, channels: u32) -> i32 {
        match crate::rs::Rs::new(rate_in as usize, rate_out as usize, channels as usize) {
            Ok(r) => { unsafe { *std::ptr::addr_of_mut!(RS) = Some(r); } 0 }
            Err(e) => fail(e),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rs_need() -> u32 { rsm().map(|r| r.input_frames() as u32).unwrap_or(0) }
    #[unsafe(no_mangle)]
    pub extern "C" fn rs_in_stride() -> u32 { rsm().map(|r| r.in_stride() as u32).unwrap_or(0) }
    #[unsafe(no_mangle)]
    pub extern "C" fn rs_out_stride() -> u32 { rsm().map(|r| r.out_stride() as u32).unwrap_or(0) }
    #[unsafe(no_mangle)]
    pub extern "C" fn rs_delay() -> u32 { rsm().map(|r| r.delay() as u32).unwrap_or(0) }
    #[unsafe(no_mangle)]
    pub extern "C" fn rs_in() -> *mut f32 { rsm().map(|r| r.inp.as_mut_ptr()).unwrap_or(std::ptr::null_mut()) }
    #[unsafe(no_mangle)]
    pub extern "C" fn rs_out() -> *const f32 { rsm().map(|r| r.out.as_ptr()).unwrap_or(std::ptr::null()) }

    #[unsafe(no_mangle)]
    pub extern "C" fn rs_process(frames: u32) -> i32 {
        let Some(r) = rsm() else { return fail("resampler not open".into()); };
        match r.process(frames as usize) {
            Ok(n) => n as i32,
            Err(e) => fail(e),
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn rs_close() {
        unsafe { *std::ptr::addr_of_mut!(RS) = None; }
    }

    static mut SHA: Option<Sha256> = None;
    static mut SHA_BUF: Vec<u8> = Vec::new();
    static mut SHA_HEX: [u8; 64] = [0; 64];

    #[unsafe(no_mangle)]
    pub extern "C" fn sha_open(cap: u32) -> *mut u8 {
        unsafe {
            *std::ptr::addr_of_mut!(SHA) = Some(Sha256::new());
            let b = &mut *std::ptr::addr_of_mut!(SHA_BUF);
            *b = vec![0; cap as usize];
            b.as_mut_ptr()
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn sha_update(len: u32) {
        unsafe {
            let b = &*std::ptr::addr_of!(SHA_BUF);
            if let Some(h) = (*std::ptr::addr_of_mut!(SHA)).as_mut() { h.update(&b[..(len as usize).min(b.len())]); }
        }
    }

    #[unsafe(no_mangle)]
    pub extern "C" fn sha_hex() -> *const u8 {
        unsafe {
            let out = &mut *std::ptr::addr_of_mut!(SHA_HEX);
            if let Some(h) = (*std::ptr::addr_of_mut!(SHA)).take() {
                let d = h.finalize();
                const HEX: &[u8; 16] = b"0123456789abcdef";
                for (i, b) in d.iter().enumerate() { out[i * 2] = HEX[(b >> 4) as usize]; out[i * 2 + 1] = HEX[(b & 15) as usize]; }
            }
            *std::ptr::addr_of_mut!(SHA_BUF) = Vec::new();
            out.as_ptr()
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Decoder;

    #[test]
    fn flac_round_trip_is_bit_exact() {
        use md5::{Digest, Md5};
        let (rate, ch, bits, block) = (96000usize, 2usize, 24usize, 4096usize);
        let n = rate * 2 + 1234;
        let mut pcm = vec![0i32; n * ch];
        let mut seed = 7u64;
        for i in 0..n {
            seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1);
            let noise = ((seed >> 40) as i32 & 0xff) - 128;
            let v = ((i as f64 * 0.031).sin() * 3_000_000.0) as i32 + noise;
            pcm[i * 2] = v;
            pcm[i * 2 + 1] = -v / 2;
        }
        let mut enc = crate::enc::Flac::new(rate, ch, bits, block).unwrap();
        let mut body = Vec::new();
        for f in pcm.chunks(block * ch) { body.extend_from_slice(enc.frame(f).unwrap()); }
        let mut file = enc.header(true).unwrap();
        file.extend_from_slice(&body);
        let mut md = Md5::new();
        for v in &pcm { md.update(&v.to_le_bytes()[..3]); }
        let want: [u8; 16] = md.finalize().into();
        assert_eq!(&file[8 + 18..8 + 34], &want, "md5 in streaminfo");
        let total = u64::from_be_bytes([0, 0, 0, file[8 + 13] & 15, file[8 + 14], file[8 + 15], file[8 + 16], file[8 + 17]]);
        assert_eq!(total, n as u64);
        let mut d = Decoder::open(Box::new(std::io::Cursor::new(file.clone())), "flac").unwrap();
        assert_eq!((d.sample_rate, d.channels, d.bits), (96000, 2, 24));
        let mut got: Vec<[f32; 2]> = Vec::new();
        loop {
            let k = d.next().unwrap();
            if k == 0 { break; }
            let p = d.planar();
            for i in 0..k { got.push([p[i], p[k + i]]); }
        }
        assert_eq!(got.len(), n);
        let scale = (1i64 << 23) as f32;
        for i in 0..n {
            assert_eq!((got[i][0] * scale).round() as i32, pcm[i * 2], "L {i}");
            assert_eq!((got[i][1] * scale).round() as i32, pcm[i * 2 + 1], "R {i}");
        }
        std::fs::write(std::env::temp_dir().join("studio-flac-test.flac"), &file).unwrap();
        assert!(body.len() < pcm.len() * 3 * 7 / 10, "compressed {} of {}", body.len(), pcm.len() * 3);
    }

    fn flac_cycle(pcm: &[i32], rate: usize, ch: usize, bits: usize, name: &str) -> usize {
        let block = 4096;
        let mut enc = crate::enc::Flac::new(rate, ch, bits, block).unwrap();
        let mut body = Vec::new();
        for f in pcm.chunks(block * ch) {
            let out = enc.frame(f).unwrap();
            assert!(out.len() <= f.len() * bits.div_ceil(8) + 64, "{name}: frame of {} bytes for {} samples", out.len(), f.len());
            body.extend_from_slice(out);
        }
        let mut file = enc.header(true).unwrap();
        file.extend_from_slice(&body);
        std::fs::write(std::env::temp_dir().join(format!("studio-flac-{name}.flac")), &file).unwrap();
        let mut d = Decoder::open(Box::new(std::io::Cursor::new(file)), "flac").unwrap();
        assert_eq!((d.sample_rate as usize, d.channels as usize, d.bits as usize), (rate, ch, bits), "{name}");
        let scale = (1i64 << (bits - 1)) as f32;
        let mut pos = 0;
        loop {
            let k = d.next().unwrap();
            if k == 0 { break; }
            let p = d.planar();
            for i in 0..k {
                for c in 0..ch {
                    assert_eq!((p[c * k + i] * scale).round() as i32, pcm[(pos + i) * ch + c], "{name}: sample {} ch {c}", pos + i);
                }
            }
            pos += k;
        }
        assert_eq!(pos * ch, pcm.len(), "{name}");
        body.len()
    }

    #[test]
    fn flac_survives_hard_material() {
        let mut seed = 99u64;
        let mut rnd = move || { seed = seed.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407); (seed >> 33) as i64 };
        let top = (1i32 << 23) - 1;
        let bottom = -(1i32 << 23);
        let n = 3 * 4096 + 1;
        let square: Vec<i32> = (0..n * 2).map(|i| if (i / 2 / 37) % 2 == 0 { top } else { bottom }).collect();
        flac_cycle(&square, 96000, 2, 24, "square");
        let wide: Vec<i32> = (0..n * 2).map(|i| if (i / 2 + i % 2) % 2 == 0 { bottom } else { top }).collect();
        flac_cycle(&wide, 96000, 2, 24, "wide");
        let clipped: Vec<i32> = (0..n * 2).map(|i| (((i / 2) as f64 * 0.013).sin() * 4.0e7 + (rnd() % 900_000) as f64).clamp(bottom as f64, top as f64) as i32).collect();
        flac_cycle(&clipped, 96000, 2, 24, "clipped");
        let noise16: Vec<i32> = (0..44_100 * 2).map(|_| (rnd() % 65_536 - 32_768) as i32).collect();
        let size = flac_cycle(&noise16, 44_100, 2, 16, "noise16");
        assert!(size <= noise16.len() * 2 + noise16.len() / 4096 * 40, "noise {size}");
        let padded: Vec<i32> = (0..30_000).map(|i| (((i as f64) * 0.02).sin() * 20_000.0) as i32 * 256 + if i % 7 == 0 { 256 } else { 0 }).collect();
        let size = flac_cycle(&padded, 48_000, 1, 24, "wasted");
        let plain: Vec<i32> = padded.iter().map(|v| v >> 8).collect();
        let size16 = flac_cycle(&plain, 48_000, 1, 16, "plain16");
        assert!(size < size16 + size16 / 50 + 200, "wasted bits {size} vs {size16}");
        let six: Vec<i32> = (0..(4096 + 17) * 6).map(|i| (((i / 6) as f64 * 0.01 * (1 + i % 6) as f64).sin() * 30_000.0) as i32).collect();
        flac_cycle(&six, 48_000, 6, 16, "six");
        let silence = vec![0i32; 5000 * 2];
        assert!(flac_cycle(&silence, 44_100, 2, 16, "silence") < 40);
        let mono_pair: Vec<i32> = (0..9000 * 2).map(|i| (((i / 2) as f64 * 0.05).sin() * 3.0e6) as i32).collect();
        flac_cycle(&mono_pair, 88_200, 2, 24, "same");
        for len in [1usize, 2, 5, 16, 17, 31, 32, 33, 255, 256, 257, 4095] {
            let short: Vec<i32> = (0..(4096 + len) * 2).map(|_| (rnd() % 2_000_000 - 1_000_000) as i32).collect();
            flac_cycle(&short, 44_100, 2, 24, &format!("tail{len}"));
        }
        let odd_rate: Vec<i32> = (0..10_000).map(|i| ((i as f64 * 0.03).sin() * 10_000.0) as i32).collect();
        for rate in [22_050usize, 37_800, 64_000, 384_000, 352_800] {
            flac_cycle(&odd_rate, rate, 1, 16, &format!("rate{rate}"));
        }
        let mut enc = crate::enc::Flac::new(44_100, 2, 16, 4096).unwrap();
        assert!(enc.frame(&[40_000, 0]).is_err());
        assert!(enc.frame(&[1, 2, 3]).is_err());
    }

    fn test_tone(sr: usize, secs: f64, seed: u64) -> Vec<f32> {
        let n = (sr as f64 * secs) as usize;
        let mut st = seed;
        (0..n)
            .map(|i| {
                let t = i as f64 / sr as f64;
                st ^= st << 13;
                st ^= st >> 7;
                st ^= st << 17;
                let w = (st >> 11) as f64 / (1u64 << 53) as f64 - 0.5;
                (0.3 * (2.0 * std::f64::consts::PI * 220.0 * t).sin() + 0.15 * (2.0 * std::f64::consts::PI * 661.0 * t + 1.0).sin() + 0.05 * (2.0 * std::f64::consts::PI * 2300.0 * t).sin() + 0.002 * w) as f32
            })
            .collect()
    }

    fn hf_err(clean: &[f32], test: &[f32]) -> f64 {
        let mut e = 0.0;
        for i in 2..clean.len() {
            let c = clean[i] as f64 - 2.0 * clean[i - 1] as f64 + clean[i - 2] as f64;
            let t = test[i] as f64 - 2.0 * test[i - 1] as f64 + test[i - 2] as f64;
            e += (t - c) * (t - c);
        }
        e
    }

    #[test]
    fn declick_finds_and_repairs_clicks() {
        use crate::restore::{context_len, detect, fill, repair_order, Detect};
        for sr in [44100usize, 96000] {
            let clean = test_tone(sr, 6.0, 3);
            let d = Detect::for_rate(sr, 50.0, 5.0);
            let mut found = Vec::new();
            detect(&clean, &d, &mut found);
            assert!(found.is_empty(), "{sr}: false detections on clean audio: {}", found.len());
            let mut dirty = clean.clone();
            let mut spots = Vec::new();
            for k in 0..20 {
                let pos = sr / 4 + k * sr / 4 + (k * 7919) % 1000;
                let len = sr / 2000 + k % 5;
                for i in 0..len {
                    let env = (-(i as f64) / len as f64 * 3.0).exp();
                    dirty[pos + i] += (0.2 * env * if i % 2 == 0 { 1.0 } else { -0.7 }) as f32;
                }
                spots.push((pos, pos + len));
            }
            detect(&dirty, &d, &mut found);
            let hit = spots.iter().filter(|&&(a, b)| found.iter().any(|c| c.start < b && c.end > a)).count();
            assert!(hit >= 19, "{sr}: found {hit} of 20 clicks");
            assert!(found.len() <= 22, "{sr}: {} detections for 20 clicks", found.len());
            let p = repair_order(sr);
            let mut fixed = dirty.clone();
            for c in &found {
                let ctx = context_len(p, c.end - c.start, false);
                let (lo, hi) = (c.start.saturating_sub(ctx), (c.end + ctx).min(fixed.len()));
                let mut buf = fixed[lo..hi].to_vec();
                let mask: Vec<bool> = (lo..hi).map(|i| i >= c.start && i < c.end).collect();
                assert!(fill(&mut buf, &mask, p));
                fixed[lo..hi].copy_from_slice(&buf);
            }
            let before = hf_err(&clean, &dirty);
            let after = hf_err(&clean, &fixed);
            assert!(10.0 * (before / after).log10() > 20.0, "{sr}: HF error only down {:.1} dB", 10.0 * (before / after).log10());
        }
    }

    #[test]
    fn interpolation_reconstructs_tones_and_textured_fill_keeps_energy() {
        use crate::restore::{fill, fill_textured, heal_order};
        let sr = 48000;
        let clean = test_tone(sr, 2.0, 9);
        let (pos, gap) = (sr / 2, 240);
        let p = heal_order(sr, gap);
        let ctx = 16 * p;
        let mut buf = clean[pos - ctx..pos + gap + ctx].to_vec();
        let mask: Vec<bool> = (0..buf.len()).map(|i| i >= ctx && i < ctx + gap).collect();
        assert!(fill(&mut buf, &mask, p));
        let (mut s, mut e) = (0.0f64, 0.0f64);
        for i in 0..gap {
            s += (clean[pos + i] as f64).powi(2);
            e += (buf[ctx + i] as f64 - clean[pos + i] as f64).powi(2);
        }
        assert!(10.0 * (s / e).log10() > 30.0, "tone gap SNR {:.1} dB", 10.0 * (s / e).log10());
        let noise: Vec<f32> = { let mut st = 5u64; (0..sr).map(|_| { st ^= st << 13; st ^= st >> 7; st ^= st << 17; ((st >> 11) as f64 / (1u64 << 53) as f64 - 0.5) as f32 * 0.2 }).collect() };
        let g = 960;
        let p = heal_order(sr, g);
        let ctx = 3 * g;
        let mut a = noise[sr / 3 - ctx..sr / 3 + g + ctx].to_vec();
        let mask: Vec<bool> = (0..a.len()).map(|i| i >= ctx && i < ctx + g).collect();
        let mut plain = a.clone();
        assert!(fill(&mut plain, &mask, p));
        assert!(fill_textured(&mut a, &mask, p, 7));
        let energy = |v: &[f32]| v[ctx..ctx + g].iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
        let orig = noise[sr / 3..sr / 3 + g].iter().map(|x| (*x as f64).powi(2)).sum::<f64>();
        let ratio = energy(&a) / orig;
        assert!(ratio > 0.6 && ratio < 1.5, "textured fill energy ratio {ratio:.2}");
        assert!(energy(&plain) / orig < 0.3, "plain fill of noise should be near the mean");
        let mut again = noise[sr / 3 - ctx..sr / 3 + g + ctx].to_vec();
        assert!(fill_textured(&mut again, &mask, p, 7));
        assert_eq!(again, a, "textured fill is deterministic for a seed");
    }

    #[test]
    fn declip_rebuilds_clipped_peaks() {
        use crate::restore::{clip_runs, context_len, declip, declip_order};
        let sr = 44100;
        let clean: Vec<f32> = test_tone(sr, 2.0, 4).iter().map(|v| v * 1.6).collect();
        let peak = clean.iter().fold(0.0f32, |a, v| a.max(v.abs()));
        let lim = peak * 10f32.powf(-3.0 / 20.0);
        let hard: Vec<f32> = clean.iter().map(|v| v.clamp(-lim, lim)).collect();
        let mut runs = Vec::new();
        clip_runs(&hard, lim, lim, 0.001, 2, &mut runs);
        assert!(!runs.is_empty());
        let p = declip_order(sr);
        let (lo, hi) = (context_len(p, 1, false), hard.len() - context_len(p, 1, false));
        let inner: Vec<&crate::restore::ClipRun> = runs.iter().filter(|q| q.start >= lo + p && q.end + p <= hi).collect();
        assert!(inner.len() > 10);
        let mut buf = hard[lo..hi].to_vec();
        let mask: Vec<bool> = (0..buf.len()).map(|i| inner.iter().any(|q| i + lo >= q.start && i + lo < q.end)).collect();
        assert!(declip(&mut buf, &mask, p));
        let (mut before, mut after) = (0.0f64, 0.0f64);
        for q in &inner {
            for i in q.start..q.end {
                let v = buf[i - lo];
                before += ((hard[i] - clean[i]) as f64).powi(2);
                after += ((v - clean[i]) as f64).powi(2);
                assert!(v.abs() >= hard[i].abs() - 1e-6, "constraint broken");
            }
        }
        let gain = 10.0 * (before / after.max(1e-30)).log10();
        assert!(gain > 10.0, "declip improved clipped samples by only {gain:.1} dB");
    }

    #[test]
    fn resampler_keeps_pitch_and_rejects_aliases() {
        let run = |rate_in: usize, rate_out: usize, freq: f64, secs: f64| -> Vec<f32> {
            let mut r = crate::rs::Rs::new(rate_in, rate_out, 1).unwrap();
            let n = (rate_in as f64 * secs) as usize;
            let src: Vec<f32> = (0..n).map(|i| (2.0 * std::f64::consts::PI * freq * i as f64 / rate_in as f64).sin() as f32 * 0.5).collect();
            let mut out = Vec::new();
            let mut pos = 0;
            let delay = r.delay();
            let want = (n as u64 * rate_out as u64).div_ceil(rate_in as u64) as usize;
            while out.len() < want + delay {
                let need = r.input_frames();
                let take = need.min(n.saturating_sub(pos));
                r.inp[..take].copy_from_slice(&src[pos..pos + take]);
                for v in &mut r.inp[take..need] { *v = 0.0; }
                pos += take;
                let k = r.process(need).unwrap();
                out.extend_from_slice(&r.out[..k]);
            }
            out[delay..delay + want].to_vec()
        };
        let a = run(96000, 44100, 1000.0, 2.0);
        assert_eq!(a.len(), 88200);
        let mid = &a[4410..a.len() - 4410];
        let crossings = mid.windows(2).filter(|w| w[0] < 0.0 && w[1] >= 0.0).count() as f64;
        let hz = crossings / (mid.len() as f64 / 44100.0);
        assert!((hz - 1000.0).abs() < 2.0, "pitch {hz}");
        let peak = mid.iter().fold(0f32, |m, v| m.max(v.abs()));
        assert!((peak - 0.5).abs() < 0.005, "level {peak}");
        let alias = run(96000, 44100, 30000.0, 1.0);
        let m = &alias[4410..alias.len() - 4410];
        let rms = (m.iter().map(|v| (*v as f64) * (*v as f64)).sum::<f64>() / m.len() as f64).sqrt();
        let db = 20.0 * (rms / (0.5 / 2f64.sqrt())).log10();
        assert!(db < -100.0, "alias rejection {db:.1} dB");
        let up = run(44100, 96000, 1000.0, 1.0);
        assert_eq!(up.len(), 96000);
        let level = |freq: f64| {
            let y = run(96000, 44100, freq, 1.0);
            let m = &y[11025..33075];
            let rms = (m.iter().map(|v| (*v as f64).powi(2)).sum::<f64>() / m.len() as f64).sqrt();
            20.0 * (rms / (0.5 / 2f64.sqrt())).log10()
        };
        for f in [20.0, 1000.0, 10000.0, 20000.0, 21500.0] { assert!(level(f).abs() < 0.01, "passband {f}: {:.3} dB", level(f)); }
        for f in [22300.0, 23000.0, 26000.0, 40000.0] { assert!(level(f) < -130.0, "stopband {f}: {:.1} dB", level(f)); }
    }

    #[test]
    fn decodes_test_files() {
        let Ok(dir) = std::env::var("STUDIO_TEST_AUDIO") else { return; };
        for name in ["test96.flac", "test96.wav", "test.mp3", "test.m4a", "test.ogg", "test.aiff", "mono.wav"] {
            let path = std::path::Path::new(&dir).join(name);
            let file = std::fs::File::open(&path).unwrap();
            let ext = path.extension().and_then(|e| e.to_str()).unwrap_or("");
            let mut d = Decoder::open(Box::new(file), ext).unwrap();
            let mut total = 0u64;
            loop {
                let n = d.next().unwrap();
                if n == 0 {
                    break;
                }
                total += n as u64;
            }
            let secs = total as f64 / d.sample_rate as f64;
            assert!((secs - 30.0).abs() < 0.1, "{name}: {secs}");
        }
    }
}

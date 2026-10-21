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

#[cfg(target_arch = "wasm32")]
mod wasm {
    use super::Decoder;
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
}

#[cfg(test)]
mod tests {
    use super::Decoder;

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

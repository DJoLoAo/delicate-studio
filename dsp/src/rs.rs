use rubato::audioadapter_buffers::direct::SequentialSlice;
use rubato::{Fft, FixedSync, Indexing, Resampler, WindowFunction};

pub struct Rs {
    r: Fft<f32>,
    pub channels: usize,
    pub inp: Vec<f32>,
    pub out: Vec<f32>,
    in_max: usize,
    out_max: usize,
}

impl Rs {
    pub fn new(rate_in: usize, rate_out: usize, channels: usize) -> Result<Self, String> {
        let r = Fft::<f32>::new_custom(rate_in, rate_out, 8192, 1, channels, WindowFunction::BlackmanHarris2, FixedSync::Input).map_err(|e| format!("resampler: {e}"))?;
        let in_max = r.input_frames_max();
        let out_max = r.output_frames_max();
        Ok(Self { r, channels, inp: vec![0.0; in_max * channels], out: vec![0.0; out_max * channels], in_max, out_max })
    }

    pub fn input_frames(&self) -> usize { self.r.input_frames_next() }
    pub fn in_stride(&self) -> usize { self.in_max }
    pub fn out_stride(&self) -> usize { self.out_max }
    pub fn delay(&self) -> usize { self.r.output_delay() }

    pub fn process(&mut self, frames: usize) -> Result<usize, String> {
        let need = self.r.input_frames_next();
        let src = SequentialSlice::new(&self.inp[..], self.channels, self.in_max).map_err(|e| format!("resampler in: {e}"))?;
        let mut dst = SequentialSlice::new_mut(&mut self.out[..], self.channels, self.out_max).map_err(|e| format!("resampler out: {e}"))?;
        let idx = Indexing { input_offset: 0, output_offset: 0, partial_len: if frames < need { Some(frames) } else { None }, active_channels_mask: None };
        let (_, n) = self.r.process_into_buffer(&src, &mut dst, Some(&idx)).map_err(|e| format!("resampler: {e}"))?;
        Ok(n)
    }
}

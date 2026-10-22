class StudioRec extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.data = new Float32Array(o.data);
    this.ctrl = new Int32Array(o.ctrl);
    this.R = o.size;
    this.M = o.size - 1;
    this.map = o.map;
    this.ch = o.map.length;
    this.pk = new Float32Array(this.ch);
    this.ss = new Float64Array(this.ch);
    this.clip = new Int32Array(this.ch);
    this.run = new Int32Array(this.ch);
    this.n = 0;
    this.every = Math.round(sampleRate / 30);
  }

  process(inputs) {
    const inp = inputs[0] || [], ctrl = this.ctrl, data = this.data, M = this.M, R = this.R;
    const frames = inp.length && inp[0] ? inp[0].length : 128;
    const w = Atomics.load(ctrl, 1);
    for (let k = 0; k < this.ch; k++) {
      const src = inp[this.map[k]], base = k * R;
      let pk = this.pk[k], ss = this.ss[k], run = this.run[k], clip = this.clip[k];
      if (!src) {
        for (let i = 0; i < frames; i++) data[base + ((w + i) & M)] = 0;
        run = 0;
      } else {
        for (let i = 0; i < frames; i++) {
          const v = src[i];
          data[base + ((w + i) & M)] = v;
          const a = v < 0 ? -v : v;
          if (a > pk) pk = a;
          ss += v * v;
          if (a >= 0.9999) { if (++run === 2) clip++; } else run = 0;
        }
      }
      this.pk[k] = pk;
      this.ss[k] = ss;
      this.run[k] = run;
      this.clip[k] = clip;
    }
    Atomics.store(ctrl, 1, (w + frames) | 0);
    this.n += frames;
    if (this.n >= this.every) {
      const rms = new Float32Array(this.ch);
      for (let k = 0; k < this.ch; k++) rms[k] = Math.sqrt(this.ss[k] / this.n);
      this.port.postMessage({ pk: Float32Array.from(this.pk), rms, clip: Int32Array.from(this.clip) });
      this.pk.fill(0);
      this.ss.fill(0);
      this.clip.fill(0);
      this.n = 0;
    }
    return true;
  }
}

registerProcessor("studio-rec", StudioRec);

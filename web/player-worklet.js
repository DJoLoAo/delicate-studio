class StudioPlayer extends AudioWorkletProcessor {
  constructor(opts) {
    super();
    const o = opts.processorOptions;
    this.data = new Float32Array(o.data);
    this.ctrl = new Int32Array(o.ctrl);
    this.R = o.size;
    this.ch = o.channels;
    this.pk = new Float32Array(this.ch);
    this.ss = new Float64Array(this.ch);
    this.n = 0;
    this.every = Math.round(sampleRate / 30);
  }

  process(inputs, outputs) {
    const out = outputs[0];
    const frames = out[0].length, ch = Math.min(this.ch, out.length), R = this.R, ctrl = this.ctrl, data = this.data;
    if (Atomics.load(ctrl, 0) === 1) {
      const w = Atomics.load(ctrl, 1);
      let r = Atomics.load(ctrl, 2);
      const end = Atomics.load(ctrl, 5);
      let n = Math.max(0, Math.min(frames, w - r));
      if (n > 0) Atomics.store(ctrl, 6, (currentFrame - r) | 0);
      if (end >= 0) n = Math.min(n, Math.max(0, end - r));
      for (let c = 0; c < ch; c++) {
        const o = out[c], base = c * R;
        for (let i = 0; i < n; i++) o[i] = data[base + ((r + i) % R)];
      }
      const finished = end >= 0 && r + n >= end;
      if (n < frames && !finished) Atomics.add(ctrl, 4, 1);
      r += n;
      Atomics.store(ctrl, 2, r);
      if (finished) Atomics.store(ctrl, 0, 2);
    }
    for (let c = 0; c < ch; c++) {
      const o = out[c];
      let pk = this.pk[c], ss = this.ss[c];
      for (let i = 0; i < frames; i++) { const v = o[i]; const a = v < 0 ? -v : v; if (a > pk) pk = a; ss += v * v; }
      this.pk[c] = pk;
      this.ss[c] = ss;
    }
    this.n += frames;
    if (this.n >= this.every) {
      const rms = new Float32Array(this.ch);
      for (let c = 0; c < this.ch; c++) rms[c] = Math.sqrt(this.ss[c] / this.n);
      this.port.postMessage({ pk: Float32Array.from(this.pk), rms });
      this.pk.fill(0);
      this.ss.fill(0);
      this.n = 0;
    }
    return true;
  }
}

registerProcessor("studio-player", StudioPlayer);

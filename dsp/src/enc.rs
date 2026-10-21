use md5::{Digest, Md5};

const MAX_LPC: usize = 12;
const MAX_PART: u32 = 8;
const RES_LIMIT: i64 = 1 << 30;

#[derive(Clone, Copy, Default, PartialEq, Debug)]
enum Kind {
    #[default]
    Verbatim,
    Constant,
    Fixed(usize),
    Lpc(usize),
}

#[derive(Default, Clone)]
struct Rice {
    order: u32,
    params: Vec<u8>,
    wide: bool,
    bits: u64,
}

#[derive(Default)]
struct Slot {
    sig: Vec<i64>,
    res: Vec<i64>,
    tmp: Vec<i64>,
    kind: Kind,
    bps: u32,
    wasted: u32,
    bits: u64,
    coefs: [i64; MAX_LPC],
    shift: i32,
    prec: u32,
    rice: Rice,
    trial: Rice,
}

#[derive(Default)]
struct Bits {
    buf: Vec<u8>,
    acc: u64,
    n: u32,
}

impl Bits {
    fn put(&mut self, v: u64, bits: u32) {
        if bits == 0 {
            return;
        }
        self.acc = (self.acc << bits) | (v & ((1u64 << bits) - 1));
        self.n += bits;
        while self.n >= 8 {
            self.n -= 8;
            self.buf.push((self.acc >> self.n) as u8);
        }
    }

    fn zeros(&mut self, mut q: u64) {
        while q >= 32 {
            self.put(0, 32);
            q -= 32;
        }
        self.put(0, q as u32);
    }

    fn align(&mut self) {
        if self.n > 0 {
            self.put(0, 8 - self.n);
        }
    }
}

pub struct Flac {
    rate: usize,
    channels: usize,
    bits: usize,
    block: usize,
    bytes: usize,
    precision: u32,
    frame_no: u64,
    samples: u64,
    min_frame: usize,
    max_frame: usize,
    md5: Md5,
    le: Vec<u8>,
    win: Vec<f64>,
    work: Vec<f64>,
    sums: Vec<u64>,
    slots: Vec<Slot>,
    out: Bits,
}

impl Flac {
    pub fn new(rate: usize, channels: usize, bits: usize, block: usize) -> Result<Self, String> {
        if !(1..=655_350).contains(&rate) {
            return Err(format!("flac: unsupported sample rate {rate}"));
        }
        if !(1..=8).contains(&channels) {
            return Err(format!("flac: unsupported channel count {channels}"));
        }
        if !(8..=24).contains(&bits) {
            return Err(format!("flac: unsupported bit depth {bits}"));
        }
        if !(16..=65_535).contains(&block) {
            return Err(format!("flac: unsupported block size {block}"));
        }
        let precision = if bits < 16 {
            (2 + bits as u32 / 2).max(5)
        } else if bits == 16 {
            match block {
                0..=192 => 7,
                193..=384 => 8,
                385..=576 => 9,
                577..=1152 => 10,
                1153..=2304 => 11,
                2305..=4608 => 12,
                _ => 13,
            }
        } else {
            match block {
                0..=384 => 13,
                385..=1152 => 14,
                _ => 15,
            }
        };
        let nslots = if channels == 2 { 4 } else { channels };
        let slots = (0..nslots)
            .map(|_| Slot { sig: vec![0; block], res: vec![0; block], tmp: vec![0; block], ..Default::default() })
            .collect();
        Ok(Self {
            rate,
            channels,
            bits,
            block,
            bytes: bits.div_ceil(8),
            precision,
            frame_no: 0,
            samples: 0,
            min_frame: usize::MAX,
            max_frame: 0,
            md5: Md5::new(),
            le: Vec::new(),
            win: Vec::new(),
            work: vec![0.0; block],
            sums: Vec::new(),
            slots,
            out: Bits::default(),
        })
    }

    pub fn frame(&mut self, interleaved: &[i32]) -> Result<&[u8], String> {
        let ch = self.channels;
        if interleaved.is_empty() || interleaved.len() % ch != 0 || interleaved.len() / ch > self.block {
            return Err(format!("flac: bad frame of {} samples", interleaved.len()));
        }
        let n = interleaved.len() / ch;
        let lim = 1i64 << (self.bits - 1);
        if interleaved.iter().any(|&v| (v as i64) < -lim || (v as i64) >= lim) {
            return Err("flac: sample out of range".into());
        }
        self.le.clear();
        for &v in interleaved {
            self.le.extend_from_slice(&v.to_le_bytes()[..self.bytes]);
        }
        self.md5.update(&self.le);
        if self.win.len() != n {
            self.win = tukey(n);
        }
        let bps = self.bits as u32;
        for c in 0..ch {
            let s = &mut self.slots[c];
            for i in 0..n {
                s.sig[i] = interleaved[i * ch + c] as i64;
            }
            s.bps = bps;
        }
        if ch == 2 {
            for i in 0..n {
                let l = self.slots[0].sig[i];
                let r = self.slots[1].sig[i];
                self.slots[2].sig[i] = l - r;
                self.slots[3].sig[i] = (l + r) >> 1;
            }
            self.slots[2].bps = bps + 1;
            self.slots[3].bps = bps;
        }
        for k in 0..self.slots.len() {
            analyze(&mut self.slots[k], n, self.precision, &self.win, &mut self.work, &mut self.sums);
        }
        let (assign, order): (u32, Vec<usize>) = if ch == 2 {
            let b = |k: usize| self.slots[k].bits;
            let opts = [(1u32, [0usize, 1usize], b(0) + b(1)), (8, [0, 2], b(0) + b(2)), (9, [2, 1], b(2) + b(1)), (10, [3, 2], b(3) + b(2))];
            let best = opts.iter().min_by_key(|o| o.2).unwrap();
            (best.0, best.1.to_vec())
        } else {
            (ch as u32 - 1, (0..ch).collect())
        };
        self.out.buf.clear();
        self.out.acc = 0;
        self.out.n = 0;
        self.write_header(n, assign);
        for &k in &order {
            write_subframe(&mut self.out, &self.slots[k], n);
        }
        self.out.align();
        let crc = crc16(&self.out.buf);
        self.out.put(crc as u64, 16);
        self.frame_no += 1;
        self.samples += n as u64;
        self.min_frame = self.min_frame.min(self.out.buf.len());
        self.max_frame = self.max_frame.max(self.out.buf.len());
        Ok(&self.out.buf)
    }

    fn write_header(&mut self, n: usize, assign: u32) {
        let (bs_code, bs_extra): (u32, Option<(u64, u32)>) = match n {
            192 => (1, None),
            576 | 1152 | 2304 | 4608 => (2 + (n / 576).trailing_zeros(), None),
            256 | 512 | 1024 | 2048 | 4096 | 8192 | 16384 | 32768 => (8 + (n / 256).trailing_zeros(), None),
            _ if n <= 256 => (6, Some(((n - 1) as u64, 8))),
            _ => (7, Some(((n - 1) as u64, 16))),
        };
        let (sr_code, sr_extra): (u32, Option<(u64, u32)>) = match self.rate {
            88_200 => (1, None),
            176_400 => (2, None),
            192_000 => (3, None),
            8_000 => (4, None),
            16_000 => (5, None),
            22_050 => (6, None),
            24_000 => (7, None),
            32_000 => (8, None),
            44_100 => (9, None),
            48_000 => (10, None),
            96_000 => (11, None),
            r if r % 1000 == 0 && r / 1000 <= 255 => (12, Some(((r / 1000) as u64, 8))),
            r if r <= 65_535 => (13, Some((r as u64, 16))),
            r if r % 10 == 0 && r / 10 <= 65_535 => (14, Some(((r / 10) as u64, 16))),
            _ => (0, None),
        };
        let ss_code = match self.bits {
            8 => 1,
            12 => 2,
            16 => 4,
            20 => 5,
            24 => 6,
            _ => 0,
        };
        let o = &mut self.out;
        o.put(0b11_1111_1111_1110, 14);
        o.put(0, 2);
        o.put(bs_code as u64, 4);
        o.put(sr_code as u64, 4);
        o.put(assign as u64, 4);
        o.put(ss_code, 3);
        o.put(0, 1);
        for b in utf8(self.frame_no) {
            o.put(b as u64, 8);
        }
        if let Some((v, w)) = bs_extra {
            o.put(v, w);
        }
        if let Some((v, w)) = sr_extra {
            o.put(v, w);
        }
        let crc = crc8(&o.buf);
        o.put(crc as u64, 8);
    }

    pub fn header(&self, last: bool) -> Result<Vec<u8>, String> {
        let mut s = Bits::default();
        s.put(self.block as u64, 16);
        s.put(self.block as u64, 16);
        let (lo, hi) = if self.frame_no > 0 { (self.min_frame, self.max_frame) } else { (0, 0) };
        s.put(lo as u64, 24);
        s.put(hi as u64, 24);
        s.put(self.rate as u64, 20);
        s.put(self.channels as u64 - 1, 3);
        s.put(self.bits as u64 - 1, 5);
        s.put(self.samples >> 32, 4);
        s.put(self.samples & 0xffff_ffff, 32);
        let digest: [u8; 16] = if self.frame_no > 0 { self.md5.clone().finalize().into() } else { [0; 16] };
        let mut out = b"fLaC".to_vec();
        out.push(if last { 0x80 } else { 0 });
        out.extend_from_slice(&[0, 0, 34]);
        out.extend_from_slice(&s.buf);
        out.extend_from_slice(&digest);
        Ok(out)
    }
}

fn zig(v: i64) -> u64 {
    ((v << 1) ^ (v >> 63)) as u64
}

fn analyze(s: &mut Slot, n: usize, precision: u32, win: &[f64], work: &mut [f64], sums: &mut Vec<u64>) {
    let first = s.sig[0];
    if s.sig[..n].iter().all(|&v| v == first) {
        s.kind = Kind::Constant;
        s.wasted = 0;
        s.bits = 8 + s.bps as u64;
        return;
    }
    let or = s.sig[..n].iter().fold(0i64, |a, &v| a | v);
    let w = or.trailing_zeros().min(s.bps - 1);
    if w > 0 {
        for v in &mut s.sig[..n] {
            *v >>= w;
        }
    }
    s.wasted = w;
    let b = (s.bps - w) as u64;
    let head = 8 + w as u64;
    s.kind = Kind::Verbatim;
    s.bits = head + n as u64 * b;
    if n > 4 {
        let order = fixed_order(&s.sig[..n]);
        fixed_residual(&s.sig[..n], order, &mut s.tmp);
        rice(&s.tmp[..n], order, n, &mut s.trial, sums);
        let bits = head + order as u64 * b + 6 + s.trial.bits;
        if bits < s.bits {
            s.bits = bits;
            s.kind = Kind::Fixed(order);
            std::mem::swap(&mut s.res, &mut s.tmp);
            std::mem::swap(&mut s.rice, &mut s.trial);
        }
    }
    if n >= 32 {
        let maxo = MAX_LPC.min(n / 4);
        let sig = &s.sig[..n];
        for i in 0..n {
            work[i] = sig[i] as f64 * win[i];
        }
        let mut autoc = [0f64; MAX_LPC + 1];
        for (lag, a) in autoc.iter_mut().enumerate().take(maxo + 1) {
            let mut sum = 0.0;
            for i in lag..n {
                sum += work[i] * work[i - lag];
            }
            *a = sum;
        }
        if autoc[0] > 0.0 {
            let mut lp = [[0f64; MAX_LPC]; MAX_LPC];
            let mut err = [0f64; MAX_LPC];
            let avail = levinson(&autoc, maxo, &mut lp, &mut err);
            if avail > 0 {
                let overhead = b as f64 + precision as f64;
                let mut best = (0usize, f64::INFINITY);
                for o in 1..=avail {
                    let left = (n - o) as f64;
                    let e = expected_bps(err[o - 1], n - o) * left + o as f64 * overhead;
                    if e < best.1 {
                        best = (o, e);
                    }
                }
                let o = best.0;
                let mut q = [0i64; MAX_LPC];
                if let Some(shift) = quantize(&lp[o - 1][..o], precision, &mut q)
                    && lpc_residual(sig, &q[..o], shift, &mut s.tmp)
                {
                    rice(&s.tmp[..n], o, n, &mut s.trial, sums);
                    let bits = head + o as u64 * b + 4 + 5 + o as u64 * precision as u64 + 6 + s.trial.bits;
                    if bits < s.bits {
                        s.bits = bits;
                        s.kind = Kind::Lpc(o);
                        s.coefs = q;
                        s.shift = shift;
                        s.prec = precision;
                        std::mem::swap(&mut s.res, &mut s.tmp);
                        std::mem::swap(&mut s.rice, &mut s.trial);
                    }
                }
            }
        }
    }
}

fn fixed_order(x: &[i64]) -> usize {
    let mut sums = [0u64; 5];
    let mut l0 = x[3];
    let mut l1 = x[3] - x[2];
    let mut l2 = l1 - (x[2] - x[1]);
    let mut l3 = l2 - (x[2] - x[1] - (x[1] - x[0]));
    for &v in &x[4..] {
        let e0 = v;
        let e1 = e0 - l0;
        let e2 = e1 - l1;
        let e3 = e2 - l2;
        let e4 = e3 - l3;
        sums[0] += e0.unsigned_abs();
        sums[1] += e1.unsigned_abs();
        sums[2] += e2.unsigned_abs();
        sums[3] += e3.unsigned_abs();
        sums[4] += e4.unsigned_abs();
        l0 = e0;
        l1 = e1;
        l2 = e2;
        l3 = e3;
    }
    (0..5).min_by_key(|&o| sums[o]).unwrap()
}

fn fixed_residual(x: &[i64], order: usize, out: &mut [i64]) {
    let n = x.len();
    match order {
        0 => out[..n].copy_from_slice(x),
        1 => (1..n).for_each(|i| out[i] = x[i] - x[i - 1]),
        2 => (2..n).for_each(|i| out[i] = x[i] - 2 * x[i - 1] + x[i - 2]),
        3 => (3..n).for_each(|i| out[i] = x[i] - 3 * x[i - 1] + 3 * x[i - 2] - x[i - 3]),
        _ => (4..n).for_each(|i| out[i] = x[i] - 4 * x[i - 1] + 6 * x[i - 2] - 4 * x[i - 3] + x[i - 4]),
    }
}

fn tukey(n: usize) -> Vec<f64> {
    let mut w = vec![1.0; n];
    let np = (0.25 * n as f64) as isize - 1;
    if np > 0 {
        let np = np as usize;
        for i in 0..=np {
            w[i] = 0.5 - 0.5 * (std::f64::consts::PI * i as f64 / np as f64).cos();
            w[n - np - 1 + i] = 0.5 - 0.5 * (std::f64::consts::PI * (i + np) as f64 / np as f64).cos();
        }
    }
    w
}

fn levinson(autoc: &[f64], maxo: usize, lp: &mut [[f64; MAX_LPC]; MAX_LPC], err_out: &mut [f64; MAX_LPC]) -> usize {
    let mut a = [0f64; MAX_LPC];
    let mut err = autoc[0];
    for i in 0..maxo {
        let mut r = -autoc[i + 1];
        for j in 0..i {
            r -= a[j] * autoc[i - j];
        }
        r /= err;
        a[i] = r;
        for j in 0..(i >> 1) {
            let t = a[j];
            a[j] += r * a[i - 1 - j];
            a[i - 1 - j] += r * t;
        }
        if i & 1 == 1 {
            a[i >> 1] += a[i >> 1] * r;
        }
        err *= 1.0 - r * r;
        for j in 0..=i {
            lp[i][j] = -a[j];
        }
        err_out[i] = err;
        if !(err > 0.0) || !err.is_finite() || lp[i][..=i].iter().any(|v| !v.is_finite()) {
            return i;
        }
    }
    maxo
}

fn expected_bps(err: f64, samples: usize) -> f64 {
    if err > 0.0 {
        (0.5 * (0.5 / samples as f64 * err).log2()).max(0.0)
    } else if err < 0.0 {
        1e32
    } else {
        0.0
    }
}

fn quantize(lp: &[f64], precision: u32, q: &mut [i64]) -> Option<i32> {
    let prec = precision as i32 - 1;
    let qmax = (1i64 << prec) - 1;
    let qmin = -(1i64 << prec);
    let cmax = lp.iter().fold(0f64, |m, v| m.max(v.abs()));
    if !(cmax > 0.0) || !cmax.is_finite() {
        return None;
    }
    let log2cmax = cmax.log2().floor() as i32 + 1;
    let shift = (prec - log2cmax).clamp(-16, 15);
    let scale = if shift >= 0 { (1u64 << shift) as f64 } else { 1.0 / (1u64 << -shift) as f64 };
    let mut e = 0.0;
    for (i, &c) in lp.iter().enumerate() {
        e += c * scale;
        let v = (e.round() as i64).clamp(qmin, qmax);
        e -= v as f64;
        q[i] = v;
    }
    Some(shift.max(0))
}

fn lpc_residual(x: &[i64], q: &[i64], shift: i32, out: &mut [i64]) -> bool {
    let o = q.len();
    for i in o..x.len() {
        let mut sum = 0i64;
        for (j, &c) in q.iter().enumerate() {
            sum += c * x[i - 1 - j];
        }
        let r = x[i] - (sum >> shift);
        if r.abs() >= RES_LIMIT {
            return false;
        }
        out[i] = r;
    }
    true
}

fn best_param(s: u64, c: u64) -> (u8, u64) {
    let cost = |p: u32| c * (p as u64 + 1) + (s >> p);
    let mut p = if s > c { 63 - (s / c).leading_zeros() } else { 0 }.min(30);
    while p > 0 && cost(p - 1) <= cost(p) {
        p -= 1;
    }
    while p < 30 && cost(p + 1) < cost(p) {
        p += 1;
    }
    (p as u8, cost(p))
}

fn rice(res: &[i64], warm: usize, n: usize, out: &mut Rice, sums: &mut Vec<u64>) {
    let mut top = MAX_PART.min(n.trailing_zeros());
    while top > 0 && (n >> top) <= warm {
        top -= 1;
    }
    let parts = 1usize << top;
    let size = n >> top;
    sums.clear();
    for p in 0..parts {
        let a = (p * size).max(warm);
        sums.push(res[a..(p + 1) * size].iter().map(|&v| zig(v)).sum());
    }
    out.bits = u64::MAX;
    let mut params = [0u8; 1 << MAX_PART];
    for o in (0..=top).rev() {
        let k = 1usize << o;
        let psize = (n >> o) as u64;
        let mut bits = 0u64;
        let mut wide = false;
        for p in 0..k {
            let c = if p == 0 { psize - warm as u64 } else { psize };
            let (pp, b) = best_param(sums[p], c);
            params[p] = pp;
            wide |= pp > 14;
            bits += 4 + b;
        }
        if wide {
            bits += k as u64;
        }
        if bits < out.bits {
            out.bits = bits;
            out.order = o;
            out.wide = wide;
            out.params.clear();
            out.params.extend_from_slice(&params[..k]);
        }
        if o > 0 {
            for p in 0..k / 2 {
                sums[p] = sums[2 * p] + sums[2 * p + 1];
            }
        }
    }
}

fn write_subframe(o: &mut Bits, s: &Slot, n: usize) {
    let b = s.bps - s.wasted;
    let kind = match s.kind {
        Kind::Constant => 0,
        Kind::Verbatim => 1,
        Kind::Fixed(k) => 8 | k as u64,
        Kind::Lpc(k) => 32 | (k as u64 - 1),
    };
    o.put(0, 1);
    o.put(kind, 6);
    if s.kind == Kind::Constant {
        o.put(0, 1);
        o.put(s.sig[0] as u64, s.bps);
        return;
    }
    if s.wasted > 0 {
        o.put(1, 1);
        o.put(1, s.wasted);
    } else {
        o.put(0, 1);
    }
    match s.kind {
        Kind::Verbatim => {
            for &v in &s.sig[..n] {
                o.put(v as u64, b);
            }
        }
        Kind::Fixed(k) => {
            for &v in &s.sig[..k] {
                o.put(v as u64, b);
            }
            write_residual(o, &s.res, k, n, &s.rice);
        }
        Kind::Lpc(k) => {
            for &v in &s.sig[..k] {
                o.put(v as u64, b);
            }
            o.put(s.prec as u64 - 1, 4);
            o.put(s.shift as u64, 5);
            for &c in &s.coefs[..k] {
                o.put(c as u64, s.prec);
            }
            write_residual(o, &s.res, k, n, &s.rice);
        }
        Kind::Constant => {}
    }
}

fn write_residual(o: &mut Bits, res: &[i64], warm: usize, n: usize, r: &Rice) {
    o.put(r.wide as u64, 2);
    o.put(r.order as u64, 4);
    let pbits = if r.wide { 5 } else { 4 };
    let size = n >> r.order;
    for (p, &k) in r.params.iter().enumerate() {
        let k = k as u32;
        o.put(k as u64, pbits);
        let a = (p * size).max(warm);
        for &v in &res[a..(p + 1) * size] {
            let u = zig(v);
            let q = u >> k;
            if q + 1 + k as u64 <= 32 {
                o.put((1u64 << k) | (u & ((1u64 << k) - 1)), q as u32 + 1 + k);
            } else {
                o.zeros(q);
                o.put((1u64 << k) | (u & ((1u64 << k) - 1)), 1 + k);
            }
        }
    }
}

fn utf8(v: u64) -> Vec<u8> {
    if v < 0x80 {
        return vec![v as u8];
    }
    let len = match v {
        0..0x800 => 2,
        0x800..0x1_0000 => 3,
        0x1_0000..0x20_0000 => 4,
        0x20_0000..0x400_0000 => 5,
        0x400_0000..0x8000_0000 => 6,
        _ => 7,
    };
    let mut out = vec![0u8; len];
    let mut x = v;
    for i in (1..len).rev() {
        out[i] = 0x80 | (x & 0x3f) as u8;
        x >>= 6;
    }
    out[0] = if len == 7 { 0xfe } else { ((0xff00u16 >> len) as u8) | x as u8 };
    out
}

fn crc8(data: &[u8]) -> u8 {
    let mut c = 0u8;
    for &b in data {
        c ^= b;
        for _ in 0..8 {
            c = if c & 0x80 != 0 { (c << 1) ^ 0x07 } else { c << 1 };
        }
    }
    c
}

fn crc16(data: &[u8]) -> u16 {
    static TABLE: std::sync::OnceLock<[u16; 256]> = std::sync::OnceLock::new();
    let t = TABLE.get_or_init(|| {
        let mut t = [0u16; 256];
        for (i, e) in t.iter_mut().enumerate() {
            let mut c = (i as u16) << 8;
            for _ in 0..8 {
                c = if c & 0x8000 != 0 { (c << 1) ^ 0x8005 } else { c << 1 };
            }
            *e = c;
        }
        t
    });
    let mut c = 0u16;
    for &b in data {
        c = (c << 8) ^ t[((c >> 8) as u8 ^ b) as usize];
    }
    c
}

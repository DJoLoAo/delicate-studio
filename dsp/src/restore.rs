#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Click {
    pub start: usize,
    pub end: usize,
    pub strength: f32,
    pub two: f32,
}

pub struct Detect {
    pub p: usize,
    pub frame: usize,
    pub k: f64,
    pub k_edge: f64,
    pub max_len: usize,
    pub guard: usize,
    pub merge: usize,
    pub onset_win: usize,
    pub onset_ratio: f64,
}

impl Detect {
    pub fn for_rate(sr: usize, sensitivity: f64, max_ms: f64) -> Self {
        let scale = sr as f64 / 44100.0;
        let frame = if sr <= 50000 { 2048 } else if sr <= 100000 { 4096 } else { 8192 };
        let s = sensitivity.clamp(0.0, 100.0);
        Detect {
            p: ((sr as f64 / 2400.0).round() as usize).clamp(12, 40),
            frame,
            k: 16.0 - 0.11 * s,
            max_len: ((max_ms.clamp(0.1, 50.0) * sr as f64 / 1000.0).round() as usize).max(2),
            guard: ((2.0 * scale).round() as usize).max(1),
            merge: ((12.0 * scale).round() as usize).max(2),
            k_edge: 3.0,
            onset_win: (sr as f64 * 0.004).round() as usize,
            onset_ratio: f64::INFINITY,
        }
    }
}

pub fn repair_order(sr: usize) -> usize {
    ((sr as f64 / 1400.0).round() as usize).clamp(24, 96)
}

pub fn heal_order(sr: usize, m: usize) -> usize {
    repair_order(sr).max(m / 4).min(256)
}

pub fn context_len(p: usize, m: usize, heal: bool) -> usize {
    if heal { (16 * p).max(3 * m) } else { (16 * p).max(4 * m) }
}

pub fn levinson(r: &[f64], p: usize, a: &mut [f64]) -> f64 {
    let mut tmp = vec![0.0; p + 1];
    for v in a.iter_mut().take(p) {
        *v = 0.0;
    }
    let mut err = r[0];
    if err <= 0.0 {
        return 0.0;
    }
    for i in 0..p {
        let mut acc = r[i + 1];
        for j in 0..i {
            acc -= a[j] * r[i - j];
        }
        let k = acc / err;
        if !k.is_finite() || k.abs() >= 1.0 {
            break;
        }
        tmp[..i].copy_from_slice(&a[..i]);
        for j in 0..i {
            a[j] = tmp[j] - k * tmp[i - 1 - j];
        }
        a[i] = k;
        err *= 1.0 - k * k;
        if err <= 0.0 {
            break;
        }
    }
    err
}

fn autocorr_masked(x: &[f64], mask: &[bool], p: usize, r: &mut [f64]) {
    for (l, v) in r.iter_mut().enumerate().take(p + 1) {
        let mut s = 0.0;
        for n in l..x.len() {
            if !mask[n] && !mask[n - l] {
                s += x[n] * x[n - l];
            }
        }
        *v = s;
    }
    r[0] *= 1.0 + 1e-6;
    for (l, v) in r.iter_mut().enumerate().take(p + 1).skip(1) {
        let g = l as f64 / (2.0 * p as f64 + 1.0);
        *v *= (-0.5 * g * g).exp();
    }
}

pub fn ar_masked(x: &[f64], mask: &[bool], p: usize) -> Vec<f64> {
    let mut r = vec![0.0; p + 1];
    autocorr_masked(x, mask, p, &mut r);
    let mut a = vec![0.0; p];
    levinson(&r, p, &mut a);
    a
}

pub fn ar_burg_masked(x: &[f64], mask: &[bool], p: usize) -> Vec<f64> {
    let mut segs: Vec<(Vec<f64>, Vec<f64>)> = Vec::new();
    let mut i = 0;
    while i < x.len() {
        if mask[i] {
            i += 1;
            continue;
        }
        let s = i;
        while i < x.len() && !mask[i] {
            i += 1;
        }
        if i - s > 1 {
            segs.push((x[s..i].to_vec(), x[s..i].to_vec()));
        }
    }
    let mut a = vec![0.0; p];
    let mut prev = vec![0.0; p];
    for m in 0..p {
        let (mut num, mut den) = (0.0, 0.0);
        for (f, b) in &segs {
            for n in m + 1..f.len() {
                num += f[n] * b[n - 1];
                den += f[n] * f[n] + b[n - 1] * b[n - 1];
            }
        }
        if den <= 1e-30 {
            break;
        }
        let k = 2.0 * num / den;
        if !k.is_finite() || k.abs() >= 1.0 {
            break;
        }
        prev[..m].copy_from_slice(&a[..m]);
        for j in 0..m {
            a[j] = prev[j] - k * prev[m - 1 - j];
        }
        a[m] = k;
        for (f, b) in segs.iter_mut() {
            for n in (m + 1..f.len()).rev() {
                let fn_ = f[n];
                let bn = b[n - 1];
                f[n] = fn_ - k * bn;
                b[n] = bn - k * fn_;
            }
        }
    }
    a
}

fn residual(x: &[f64], a: &[f64], n: usize) -> f64 {
    let mut pred = 0.0;
    for (k, &ak) in a.iter().enumerate() {
        pred += ak * x[n - 1 - k];
    }
    x[n] - pred
}

fn median_abs(v: &[f64], scratch: &mut Vec<f64>) -> f64 {
    scratch.clear();
    scratch.extend(v.iter().map(|x| x.abs()));
    if scratch.is_empty() {
        return 0.0;
    }
    let mid = scratch.len() / 2;
    scratch.select_nth_unstable_by(mid, |a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    scratch[mid]
}

fn detect_frame(x: &[f64], a: &[f64], lo: usize, hi: usize, d: &Detect, floor: f64, scratch: &mut Vec<f64>, hits: &mut Vec<(usize, f64)>) -> f64 {
    let p = a.len();
    hits.clear();
    let n0 = lo.max(p);
    let n1 = hi.min(x.len());
    if n1 <= n0 + p {
        return 0.0;
    }
    let mut e = vec![0.0; n1 - n0];
    for n in n0..n1 {
        e[n - n0] = residual(x, a, n);
    }
    let m = e.len() - p;
    let mut s = vec![0.0; m];
    for i in 0..m {
        let mut acc = e[i];
        for k in 0..p {
            acc -= a[k] * e[i + 1 + k];
        }
        s[i] = acc;
    }
    let sigma = (1.4826 * median_abs(&s, scratch) + 1e-12).max(floor);
    let th = d.k * sigma;
    for i in 0..m {
        let v = s[i].abs();
        if v > th {
            hits.push((n0 + i, v / sigma));
        }
    }
    sigma
}

fn backward(x: &[f64], a: &[f64], n: usize) -> f64 {
    let mut pred = 0.0;
    for (k, &ak) in a.iter().enumerate() {
        pred += ak * x[n + 1 + k];
    }
    x[n] - pred
}

fn mean_sq(x: &[f64], a: usize, b: usize) -> f64 {
    if b <= a {
        return 0.0;
    }
    x[a..b].iter().map(|v| v * v).sum::<f64>() / (b - a) as f64
}

pub fn detect(x32: &[f32], d: &Detect, out: &mut Vec<Click>) {
    let n = x32.len();
    out.clear();
    if n < d.frame {
        return;
    }
    let p = d.p;
    let x: Vec<f64> = x32.iter().map(|&v| v as f64).collect();
    let mut flags = vec![false; n];
    let mut stat = vec![0.0f64; n];
    let mut ef = vec![0.0f64; n];
    let mut eb = vec![0.0f64; n];
    let mut sf = vec![f64::INFINITY; n];
    let mut sb = vec![f64::INFINITY; n];
    let mut scratch = Vec::new();
    let mut hits = Vec::new();
    let hop = d.frame / 2;
    let win: Vec<f64> = (0..d.frame).map(|i| 0.5 - 0.5 * (2.0 * std::f64::consts::PI * (i as f64 + 0.5) / d.frame as f64).cos()).collect();
    let mut r = vec![0.0; p + 1];
    let mut a = vec![0.0; p];
    let mut wx = vec![0.0; d.frame];
    let mut f0 = 0usize;
    loop {
        let f1 = (f0 + d.frame).min(n);
        let len = f1 - f0;
        if len < p * 4 {
            break;
        }
        for i in 0..len {
            wx[i] = x[f0 + i] * win[i * d.frame / len.max(1)];
        }
        for (l, rv) in r.iter_mut().enumerate() {
            let mut s = 0.0;
            for i in l..len {
                s += wx[i] * wx[i - l];
            }
            *rv = s;
        }
        r[0] *= 1.0 + 1e-9;
        let lo = if f0 == 0 { 0 } else { f0 + hop / 2 };
        let hi = if f1 == n { n } else { f0 + hop / 2 + hop };
        if r[0] > 1e-20 {
            levinson(&r, p, &mut a);
            let s1 = detect_frame(&x, &a, lo.saturating_sub(p), (hi + p).min(n), d, 0.0, &mut scratch, &mut hits);
            if hits.iter().any(|&(h, _)| h >= lo && h < hi) {
                let mut mask = vec![false; len];
                for &(h, _) in &hits {
                    let a0 = h.saturating_sub(d.guard + p / 2).max(f0);
                    let a1 = (h + d.guard + p / 2 + 1).min(f1);
                    for m in a0..a1 {
                        mask[m - f0] = true;
                    }
                }
                let mut first: Vec<usize> = hits.iter().map(|h| h.0).collect();
                first.sort_unstable();
                a = ar_masked(&wx[..len], &mask, p);
                detect_frame(&x, &a, lo.saturating_sub(p), (hi + p).min(n), d, s1, &mut scratch, &mut hits);
                hits.retain(|&(h, _)| {
                    let i = first.partition_point(|&t| t + p < h);
                    i < first.len() && first[i] <= h + p
                });
                for &(h, v) in &hits {
                    if h >= lo && h < hi {
                        flags[h] = true;
                        if v > stat[h] {
                            stat[h] = v;
                        }
                    }
                }
            }
            let (e0, e1) = (lo.max(p), hi.min(n - p));
            if e1 > e0 {
                for t in e0..e1 {
                    ef[t] = residual(&x, &a, t);
                    eb[t] = backward(&x, &a, t);
                }
                let s_f = 1.4826 * median_abs(&ef[e0..e1], &mut scratch) + 1e-12;
                let s_b = 1.4826 * median_abs(&eb[e0..e1], &mut scratch) + 1e-12;
                for t in e0..e1 {
                    sf[t] = s_f;
                    sb[t] = s_b;
                }
            }
        }
        if f1 == n {
            break;
        }
        f0 += hop;
    }
    let win_on = d.onset_win;
    let gap_on = d.guard * 2;
    let mut i = 0;
    while i < n {
        if !flags[i] {
            i += 1;
            continue;
        }
        let c0 = i;
        let mut c1 = i + 1;
        let mut peak = stat[i];
        let mut j = i + 1;
        while j < n && j <= c1 + d.merge {
            if flags[j] {
                c1 = j + 1;
                if stat[j] > peak {
                    peak = stat[j];
                }
            }
            j += 1;
        }
        i = c1 + d.merge + 1;
        let (w0, w1) = (c0.saturating_sub(p), (c1 + p).min(n));
        let core: Vec<usize> = (w0..w1).filter(|&t| ef[t].abs() > d.k_edge * sf[t] && eb[t].abs() > d.k_edge * sb[t]).collect();
        let (r0, r1) = match (core.first(), core.last()) {
            (Some(&f), Some(&l)) => (f, l + 1),
            _ => (c0, c1),
        };
        let two = (w0..w1).map(|t| (ef[t].abs() / sf[t]).min(eb[t].abs() / sb[t])).fold(0.0f64, f64::max);
        let s = r0.saturating_sub(d.guard);
        let e = (r1 + d.guard).min(n);
        if e - s > d.max_len {
            continue;
        }
        let pre = mean_sq(&x, s.saturating_sub(gap_on + win_on), s.saturating_sub(gap_on));
        let post = mean_sq(&x, (e + gap_on).min(n), (e + gap_on + win_on).min(n));
        if post > d.onset_ratio * pre && pre > 0.0 {
            continue;
        }
        out.push(Click { start: s, end: e, strength: peak as f32, two: two as f32 });
    }
}

pub fn lsar(x: &mut [f64], unknown: &[usize], a: &[f64]) -> bool {
    lsar_core(x, unknown, a, None)
}

fn gauss(st: &mut u64) -> f64 {
    let mut u = || {
        *st ^= *st << 13;
        *st ^= *st >> 7;
        *st ^= *st << 17;
        ((*st >> 11) as f64 + 0.5) / (1u64 << 53) as f64
    };
    let (u1, u2) = (u(), u());
    (-2.0 * u1.ln()).sqrt() * (2.0 * std::f64::consts::PI * u2).cos()
}

fn lsar_core(x: &mut [f64], unknown: &[usize], a: &[f64], excite: Option<(f64, u64)>) -> bool {
    let p = a.len();
    let m = unknown.len();
    if m == 0 {
        return true;
    }
    let (u0, u1) = (unknown[0], unknown[m - 1]);
    if u0 < p || u1 + p >= x.len() {
        return false;
    }
    let mut c = vec![1.0; p + 1];
    for k in 0..p {
        c[k + 1] = -a[k];
    }
    let mut rc = vec![0.0; p + 1];
    for l in 0..=p {
        let mut s = 0.0;
        for k in 0..=p - l {
            s += c[k] * c[k + l];
        }
        rc[l] = s;
    }
    for &u in unknown {
        x[u] = 0.0;
    }
    let rows = u1 + p + 1 - u0;
    let mut e0 = vec![0.0; rows];
    for (ri, n) in (u0..=u1 + p).enumerate() {
        let mut s = 0.0;
        for k in 0..=p {
            s += c[k] * x[n - k];
        }
        e0[ri] = s;
    }
    let mut b = vec![0.0; m];
    for (i, &u) in unknown.iter().enumerate() {
        let mut s = 0.0;
        for l in 0..=p {
            s += c[l] * e0[u + l - u0];
        }
        b[i] = -s;
    }
    let w = p.min(m.saturating_sub(1));
    let load = rc[0] * 1e-12;
    let mut l = vec![0.0; m * (w + 1)];
    let at = |i: usize, k: usize| i * (w + 1) + k;
    for i in 0..m {
        let jmin = i.saturating_sub(w);
        for j in jmin..=i {
            let gap = unknown[i] - unknown[j];
            let mut sum = if gap <= p { rc[gap] } else { 0.0 };
            if i == j {
                sum += load;
            }
            let kmin = jmin.max(j.saturating_sub(w));
            for k in kmin..j {
                sum -= l[at(i, i - k)] * l[at(j, j - k)];
            }
            if i == j {
                if sum <= 0.0 || !sum.is_finite() {
                    return false;
                }
                l[at(i, 0)] = sum.sqrt();
            } else {
                l[at(i, i - j)] = sum / l[at(j, 0)];
            }
        }
    }
    let mut y = b;
    for i in 0..m {
        let mut s = y[i];
        for k in i.saturating_sub(w)..i {
            s -= l[at(i, i - k)] * y[k];
        }
        y[i] = s / l[at(i, 0)];
    }
    for i in (0..m).rev() {
        let mut s = y[i];
        for k in i + 1..(i + w + 1).min(m) {
            s -= l[at(k, k - i)] * y[k];
        }
        y[i] = s / l[at(i, 0)];
    }
    if let Some((sigma, seed)) = excite {
        let mut st = seed | 1;
        let mut z: Vec<f64> = (0..m).map(|_| gauss(&mut st)).collect();
        for i in (0..m).rev() {
            let mut s = z[i];
            for k in i + 1..(i + w + 1).min(m) {
                s -= l[at(k, k - i)] * z[k];
            }
            z[i] = s / l[at(i, 0)];
        }
        for i in 0..m {
            y[i] += sigma * z[i];
        }
    }
    for (i, &u) in unknown.iter().enumerate() {
        if !y[i].is_finite() {
            return false;
        }
        x[u] = y[i];
    }
    true
}

fn floored(x: &[f64], mask: &[bool], db: f64) -> Vec<f64> {
    let (mut ss, mut nn) = (0.0f64, 0.0f64);
    for i in 0..x.len() {
        if !mask[i] {
            ss += x[i] * x[i];
            nn += 1.0;
        }
    }
    let amp = (ss / nn.max(1.0)).sqrt() * 10f64.powf(db / 20.0) * 3f64.sqrt();
    let mut st = 0x2545_F491_4F6C_DD1Du64;
    x.iter()
        .map(|&v| {
            st ^= st << 13;
            st ^= st >> 7;
            st ^= st << 17;
            v + amp * ((st >> 11) as f64 / (1u64 << 53) as f64 * 2.0 - 1.0)
        })
        .collect()
}

pub fn fill(x32: &mut [f32], mask: &[bool], p: usize) -> bool {
    fill_with(x32, mask, p, -70.0, None)
}

pub fn fill_textured(x32: &mut [f32], mask: &[bool], p: usize, seed: u64) -> bool {
    fill_with(x32, mask, p, -70.0, Some(seed))
}

pub fn fill_with(x32: &mut [f32], mask: &[bool], p: usize, floor_db: f64, texture: Option<u64>) -> bool {
    let x: Vec<f64> = x32.iter().map(|&v| v as f64).collect();
    let unknown: Vec<usize> = (0..x.len()).filter(|&i| mask[i]).collect();
    if unknown.is_empty() {
        return true;
    }
    let a = ar_burg_masked(&floored(&x, mask, floor_db), mask, p);
    let excite = texture.map(|seed| {
        let (mut ss, mut nn) = (0.0f64, 0.0f64);
        for n in p..x.len() {
            if mask[n - p..=n].iter().any(|&m| m) {
                continue;
            }
            let e = residual(&x, &a, n);
            ss += e * e;
            nn += 1.0;
        }
        ((ss / nn.max(1.0)).sqrt(), seed)
    });
    let mut y = x;
    if !lsar_core(&mut y, &unknown, &a, excite) {
        return false;
    }
    for &u in &unknown {
        x32[u] = y[u] as f32;
    }
    true
}

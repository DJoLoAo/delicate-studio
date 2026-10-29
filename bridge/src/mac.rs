use crate::drive::{C2, Drive, Q, Read, SECTOR, Toc, parse_toc};
use std::ffi::CString;
use std::os::raw::{c_int, c_ulong, c_void};

const AREA_USER: u8 = 0x10;
const AREA_C2: u8 = 0x02;
const AREA_Q: u8 = 0x04;
const TYPE_CDDA: u8 = 0x01;

#[repr(C)]
struct CdRead {
    offset: u64,
    sector_area: u8,
    sector_type: u8,
    reserved: [u8; 10],
    buffer_length: u32,
    buffer: *mut c_void,
}

#[repr(C)]
struct CdIsrc {
    isrc: [u8; 13],
    track: u8,
    reserved: [u8; 2],
}

#[repr(C)]
struct CdMcn {
    mcn: [u8; 14],
    reserved: [u8; 2],
}

#[repr(C)]
struct CdToc {
    format: u8,
    format_as_time: u8,
    reserved: [u8; 5],
    address: u8,
    reserved2: [u8; 6],
    buffer_length: u16,
    buffer: *mut c_void,
}

const fn iowr(g: u8, n: u8, size: usize) -> c_ulong {
    (0xC000_0000u32 | (((size as u32) & 0x1fff) << 16) | ((g as u32) << 8) | n as u32) as c_ulong
}

const DKIOCCDREAD: c_ulong = iowr(b'd', 96, std::mem::size_of::<CdRead>());
const DKIOCCDREADISRC: c_ulong = iowr(b'd', 97, std::mem::size_of::<CdIsrc>());
const DKIOCCDREADMCN: c_ulong = iowr(b'd', 98, std::mem::size_of::<CdMcn>());
const DKIOCCDREADTOC: c_ulong = iowr(b'd', 100, std::mem::size_of::<CdToc>());

pub struct MacDrive {
    fd: c_int,
    dev: String,
    model: String,
}

unsafe impl Send for MacDrive {}

impl Drop for MacDrive {
    fn drop(&mut self) {
        unsafe { libc::close(self.fd); }
    }
}

fn raw_toc(fd: c_int, format: u8) -> Option<Vec<u8>> {
    let mut buf = vec![0u8; 65535];
    let mut r = CdToc { format, format_as_time: 1, reserved: [0; 5], address: 0, reserved2: [0; 6], buffer_length: buf.len() as u16, buffer: buf.as_mut_ptr() as *mut c_void };
    let rc = unsafe { libc::ioctl(fd, DKIOCCDREADTOC, &mut r as *mut CdToc) };
    if rc != 0 || r.buffer_length < 4 { return None; }
    buf.truncate(r.buffer_length as usize);
    Some(buf)
}

fn cstr(b: &[u8]) -> Option<String> {
    let s: String = b.iter().take_while(|c| **c != 0).map(|c| *c as char).collect();
    let s = s.trim().to_string();
    if s.is_empty() || s.chars().all(|c| c == '0') { None } else { Some(s) }
}

fn models() -> Vec<(String, String)> {
    let Ok(out) = std::process::Command::new("/usr/bin/drutil").arg("status").output() else { return Vec::new(); };
    let text = String::from_utf8_lossy(&out.stdout).to_string();
    let lines: Vec<&str> = text.lines().collect();
    let mut found = Vec::new();
    let mut model = String::new();
    for (i, l) in lines.iter().enumerate() {
        if l.trim_start().starts_with("Vendor") && l.contains("Product") {
            if let Some(n) = lines.get(i + 1) {
                let tok: Vec<&str> = n.split_whitespace().collect();
                if tok.len() >= 2 { model = format!("{} - {}", tok[0], tok[1..tok.len() - 1].join(" ")); }
            }
        }
        if let Some(p) = l.find("Name: /dev/") {
            let dev = l[p + 6..].split_whitespace().next().unwrap_or("").to_string();
            found.push((dev, model.clone()));
        }
    }
    found
}

pub fn list() -> Vec<Box<dyn Drive>> {
    let named = models();
    let mut out: Vec<Box<dyn Drive>> = Vec::new();
    for n in 0..32 {
        let dev = format!("/dev/rdisk{}", n);
        let Ok(path) = CString::new(dev.clone()) else { continue; };
        let fd = unsafe { libc::open(path.as_ptr(), libc::O_RDONLY | libc::O_NONBLOCK) };
        if fd < 0 { continue; }
        if raw_toc(fd, 2).and_then(|b| parse_toc(&b).ok()).is_none() { unsafe { libc::close(fd); } continue; }
        let model = named.iter().find(|(d, _)| d == &format!("/dev/disk{}", n)).map(|x| x.1.clone()).filter(|m| !m.is_empty()).unwrap_or_else(|| format!("disk{}", n));
        out.push(Box::new(MacDrive { fd, dev, model }));
    }
    out
}

impl Drive for MacDrive {
    fn name(&self) -> String { self.model.clone() }

    fn toc(&mut self) -> Result<Toc, String> {
        let b = raw_toc(self.fd, 2).ok_or_else(|| format!("{}: no table of contents", self.dev))?;
        parse_toc(&b)
    }

    fn read(&mut self, lba: u32, n: u32, c2: bool, q: bool) -> Result<Read, String> {
        let area = AREA_USER | if c2 { AREA_C2 } else { 0 } | if q { AREA_Q } else { 0 };
        let per = SECTOR + if c2 { C2 } else { 0 } + if q { Q } else { 0 };
        let mut buf = vec![0u8; per * n as usize];
        let mut r = CdRead { offset: lba as u64 * per as u64, sector_area: area, sector_type: TYPE_CDDA, reserved: [0; 10], buffer_length: buf.len() as u32, buffer: buf.as_mut_ptr() as *mut c_void };
        let rc = unsafe { libc::ioctl(self.fd, DKIOCCDREAD, &mut r as *mut CdRead) };
        if rc != 0 { return Err(format!("read {}: {}", lba, std::io::Error::last_os_error())); }
        if (r.buffer_length as usize) < per * n as usize { return Err(format!("read {}: short", lba)); }
        let mut audio = Vec::with_capacity(SECTOR * n as usize);
        let mut errs = if c2 { Some(Vec::with_capacity(C2 * n as usize)) } else { None };
        let mut subq = if q { Some(Vec::with_capacity(n as usize)) } else { None };
        for s in buf.chunks(per) {
            audio.extend_from_slice(&s[..SECTOR]);
            let mut o = SECTOR;
            if let Some(e) = errs.as_mut() { e.extend_from_slice(&s[o..o + C2]); o += C2; }
            if let Some(v) = subq.as_mut() { let mut x = [0u8; Q]; x.copy_from_slice(&s[o..o + Q]); v.push(x); }
        }
        Ok(Read { audio, c2: errs, q: subq })
    }

    fn isrc(&mut self, track: u8) -> Option<String> {
        let mut r = CdIsrc { isrc: [0; 13], track, reserved: [0; 2] };
        let rc = unsafe { libc::ioctl(self.fd, DKIOCCDREADISRC, &mut r as *mut CdIsrc) };
        if rc != 0 { return None; }
        cstr(&r.isrc)
    }

    fn mcn(&mut self) -> Option<String> {
        let mut r = CdMcn { mcn: [0; 14], reserved: [0; 2] };
        let rc = unsafe { libc::ioctl(self.fd, DKIOCCDREADMCN, &mut r as *mut CdMcn) };
        if rc != 0 { return None; }
        cstr(&r.mcn)
    }

    fn cdtext(&mut self) -> Option<Vec<u8>> {
        let b = raw_toc(self.fd, 5)?;
        if b.len() <= 4 { None } else { Some(b[4..].to_vec()) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout() {
        assert_eq!(std::mem::size_of::<CdRead>(), 32);
        assert_eq!(std::mem::size_of::<CdIsrc>(), 16);
        assert_eq!(std::mem::size_of::<CdMcn>(), 16);
        assert_eq!(std::mem::size_of::<CdToc>(), 24);
        assert_eq!(DKIOCCDREAD, 0xC0206460);
        assert_eq!(DKIOCCDREADTOC, 0xC0186464);
    }
}

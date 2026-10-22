use symphonia::core::formats::FormatReader;
use symphonia::core::meta::{StandardTag, StandardVisualKey, Tag, Visual};

fn esc(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => out.push_str(&format!("\\u{:04x}", c as u32)),
            c => out.push(c),
        }
    }
    out.push('"');
}

fn std_key(t: &StandardTag) -> Option<(&'static str, String)> {
    use StandardTag::*;
    Some(match t {
        TrackTitle(v) => ("TITLE", v.to_string()),
        Artist(v) => ("ARTIST", v.to_string()),
        AlbumArtist(v) => ("ALBUMARTIST", v.to_string()),
        Album(v) => ("ALBUM", v.to_string()),
        TrackNumber(v) => ("TRACKNUMBER", v.to_string()),
        TrackTotal(v) => ("TRACKTOTAL", v.to_string()),
        DiscNumber(v) => ("DISCNUMBER", v.to_string()),
        DiscTotal(v) => ("DISCTOTAL", v.to_string()),
        Genre(v) => ("GENRE", v.to_string()),
        ReleaseDate(v) | RecordingDate(v) => ("DATE", v.to_string()),
        ReleaseYear(v) | RecordingYear(v) => ("DATE", v.to_string()),
        Comment(v) => ("COMMENT", v.to_string()),
        Description(v) => ("DESCRIPTION", v.to_string()),
        Composer(v) => ("COMPOSER", v.to_string()),
        Performer(v) => ("PERFORMER", v.to_string()),
        Conductor(v) => ("CONDUCTOR", v.to_string()),
        Remixer(v) => ("REMIXER", v.to_string()),
        Label(v) => ("ORGANIZATION", v.to_string()),
        IdentCatalogNumber(v) => ("CATALOGNUMBER", v.to_string()),
        IdentIsrc(v) => ("ISRC", v.to_string()),
        IdentBarcode(v) | IdentUpc(v) | IdentEanUpn(v) => ("BARCODE", v.to_string()),
        Bpm(v) => ("BPM", v.to_string()),
        InitialKey(v) => ("INITIALKEY", v.to_string()),
        Copyright(v) => ("COPYRIGHT", v.to_string()),
        Lyrics(v) => ("LYRICS", v.to_string()),
        Grouping(v) => ("GROUPING", v.to_string()),
        MediaFormat(v) => ("MEDIA", v.to_string()),
        ReleaseCountry(v) => ("RELEASECOUNTRY", v.to_string()),
        Language(v) => ("LANGUAGE", v.to_string()),
        EncodedBy(v) => ("ENCODEDBY", v.to_string()),
        Encoder(v) => ("ENCODER", v.to_string()),
        Url(v) => ("WEBSITE", v.to_string()),
        _ => return None,
    })
}

fn pick(cur: &Option<Visual>, v: &Visual) -> bool {
    match cur {
        None => true,
        Some(c) => !matches!(c.usage, Some(StandardVisualKey::FrontCover)) && matches!(v.usage, Some(StandardVisualKey::FrontCover)),
    }
}

fn push(out: &mut Vec<(String, String)>, k: &str, v: String) {
    let v = v.trim().to_string();
    if v.is_empty() || k.is_empty() {
        return;
    }
    if out.last().is_some_and(|(a, b)| a == k && *b == v) {
        return;
    }
    out.push((k.to_string(), v));
}

fn take(tags: &[Tag], native: bool, out: &mut Vec<(String, String)>) {
    for t in tags {
        if native {
            push(out, &t.raw.key.to_ascii_uppercase(), t.raw.value.to_string());
        } else if let Some((k, v)) = t.std.as_ref().and_then(std_key) {
            push(out, k, v);
        }
    }
}

pub fn read(format: &mut dyn FormatReader) -> (String, Vec<u8>) {
    let mut tags: Vec<(String, String)> = Vec::new();
    let mut cover: Option<Visual> = None;
    let mut src: Vec<&'static str> = Vec::new();
    let mut log = format.metadata();
    loop {
        if let Some(rev) = log.current() {
            let native = matches!(rev.info.short_name, "flac" | "vorbis" | "opus");
            src.push(rev.info.short_name);
            take(&rev.media.tags, native, &mut tags);
            for p in &rev.per_track {
                take(&p.metadata.tags, native, &mut tags);
            }
            for v in rev.media.visuals.iter().chain(rev.per_track.iter().flat_map(|p| p.metadata.visuals.iter())) {
                if pick(&cover, v) {
                    cover = Some(v.clone());
                }
            }
        }
        if log.pop().is_none() {
            break;
        }
    }
    let mut j = String::from("{\"tags\":[");
    for (i, (k, v)) in tags.iter().enumerate() {
        if i > 0 {
            j.push(',');
        }
        j.push('[');
        esc(k, &mut j);
        j.push(',');
        esc(v, &mut j);
        j.push(']');
    }
    j.push_str("],\"src\":[");
    for (i, s) in src.iter().enumerate() {
        if i > 0 {
            j.push(',');
        }
        esc(s, &mut j);
    }
    j.push(']');
    let data = match cover {
        Some(v) => {
            j.push_str(",\"cover\":{\"mime\":");
            esc(v.media_type.as_deref().unwrap_or(""), &mut j);
            let (w, h) = v.dimensions.map(|d| (d.width, d.height)).unwrap_or((0, 0));
            j.push_str(&format!(",\"w\":{w},\"h\":{h}}}"));
            v.data.to_vec()
        }
        None => Vec::new(),
    };
    j.push('}');
    (j, data)
}

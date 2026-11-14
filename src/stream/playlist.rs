//! Playlist rewriting for the streaming proxy: every URI of an upstream
//! playlist becomes a local name in the session's folder, recorded in the
//! session's table ([`Table`]). Nothing else is ever served: the table is
//! the only way a local name reaches an upstream URL.
//!
//! - master: variants (`EXT-X-STREAM-INF` + the URI line), renditions
//!   (`EXT-X-MEDIA:…URI=`), I-frame lists (`EXT-X-I-FRAME-STREAM-INF:…URI=`),
//!   `EXT-X-SESSION-KEY`;
//! - media: segments, `EXT-X-KEY` (AES-128 identity keys; anything else is
//!   DRM and ends the session), `EXT-X-MAP` (byte ranges kept: the player
//!   sends them as `Range`, which the proxy forwards);
//! - relative, absolute, protocol-relative and query-only URIs (resolved
//!   against the playlist's final URL), CRLF line ends;
//! - low-latency parts, preload hints, rendition reports and session data
//!   with a URI are dropped (they would reach the network unproxied, and
//!   full segments are listed anyway).
//!
//! Every URI comes with a [`Desc`]: what it is, independent of its URL
//! (variant resolution / bandwidth / codecs, rendition type / language /
//! name, segment start time and duration, key / map position). The table
//! matches re-read playlists — including a fresh link from another CDN,
//! with another variant order, bandwidths, rendition groups, names and
//! media-sequence base — onto the names it already gave by `Desc`, so a
//! name the player has never changes meaning.

use crate::dl::hls::{Manifest, attr, resolve};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Role {
    Playlist,
    Segment,
    Key,
    Map,
    /// A progressive file (`kind: "file"`).
    File,
}

impl Role {
    /// The first letter of its local names.
    pub(crate) fn letter(self) -> char {
        match self {
            Role::Playlist => 'p',
            Role::Segment => 'r',
            Role::Key => 'k',
            Role::Map => 'm',
            Role::File => 'f',
        }
    }
}

/// What an entry is, independent of its URL.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum Desc {
    /// The session's entry (playlist or file).
    Entry,
    Variant { bw: u64, w: u32, h: u32, codecs: String, ord: usize },
    IFrame { bw: u64, w: u32, h: u32, ord: usize },
    Rendition { kind: String, lang: String, name: String, ord: usize },
    /// `start`: the sum of the EXTINF durations before it.
    Segment { seq: u64, start: f64, dur: f64 },
    Key { path: String, ord: usize },
    Map { path: String, range: String, ord: usize },
}

const T_EPS: f64 = 0.1;

impl Desc {
    /// The same thing (`self` read before, `new` now).
    pub(crate) fn same(&self, new: &Desc) -> bool {
        use Desc::*;
        match (self, new) {
            (Entry, Entry) => true,
            (Variant { bw, w, h, codecs, .. }, Variant { bw: b2, w: w2, h: h2, codecs: c2, .. }) => {
                bw == b2 && w == w2 && h == h2 && (codecs == c2 || codecs.is_empty() || c2.is_empty())
            }
            (IFrame { bw, w, h, .. }, IFrame { bw: b2, w: w2, h: h2, .. }) => bw == b2 && w == w2 && h == h2,
            (Rendition { kind, lang, name, .. }, Rendition { kind: k2, lang: l2, name: n2, .. }) => kind == k2 && lang == l2 && name == n2,
            (Segment { seq, start, dur }, Segment { seq: s2, start: t2, dur: d2 }) => {
                if *dur > 0.0 && *d2 > 0.0 {
                    (start - t2).abs() < T_EPS && (dur - d2).abs() < T_EPS
                } else {
                    seq == s2
                }
            }
            (Key { path, .. }, Key { path: p2, .. }) => path == p2,
            (Map { path, range, .. }, Map { path: p2, range: r2, .. }) => path == p2 && range == r2,
            _ => false,
        }
    }

    /// How close `new` is to `self` when it is not [`Desc::same`] (lower is
    /// closer); `None` when it cannot stand for it.
    pub(crate) fn near(&self, new: &Desc) -> Option<u64> {
        use Desc::*;
        match (self, new) {
            (Variant { bw, w, h, .. }, Variant { bw: b2, w: w2, h: h2, .. }) if w == w2 && h == h2 && (*h > 0 || bw.abs_diff(*b2) * 4 < (*bw).max(1)) => {
                Some(bw.abs_diff(*b2))
            }
            (IFrame { w, h, .. }, IFrame { w: w2, h: h2, .. }) if w == w2 && h == h2 => Some(0),
            (Rendition { kind, lang, ord, .. }, Rendition { kind: k2, lang: l2, ord: o2, .. }) if kind == k2 => {
                if lang == l2 && !lang.is_empty() { Some(1) } else if lang.is_empty() && l2.is_empty() { Some(10 + ord.abs_diff(*o2) as u64) } else { None }
            }
            (Segment { start, dur, .. }, Segment { start: t2, dur: d2, .. }) if (start - t2).abs() < 0.5 && (dur - d2).abs() < 0.5 => {
                Some(((start - t2).abs() * 1000.0) as u64)
            }
            (Key { ord, .. }, Key { ord: o2, .. }) if ord == o2 => Some(0),
            (Map { ord, .. }, Map { ord: o2, .. }) if ord == o2 => Some(0),
            _ => None,
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RewriteError {
    /// SAMPLE-AES / FairPlay / Widevine keys.
    Drm,
    /// Not a playlist (an error page, binary data).
    NotPlaylist,
}

/// Where the rewriter records the URIs it replaces.
pub(crate) trait Table {
    /// A rewrite of playlist `parent` starts.
    fn begin(&mut self, parent: usize) {
        let _ = parent;
    }
    /// The local name for `desc` in playlist `parent`, now pointing at
    /// `url` (an entry it already gave, matched by `desc`, else a new one:
    /// a name never changes, see [`local_name`]).
    fn register(&mut self, parent: usize, desc: Desc, url: String, role: Role) -> String;
}

/// A lowercase extension of `url`'s path (1–5 alphanumerics), if any.
fn path_ext(url: &str) -> Option<String> {
    let path = url::Url::parse(url).map(|u| u.path().to_owned()).unwrap_or_else(|_| url.to_owned());
    let last = path.rsplit('/').next()?;
    let (_, ext) = last.rsplit_once('.')?;
    let ok = !ext.is_empty() && ext.len() <= 5 && ext.bytes().all(|b| b.is_ascii_alphanumeric());
    ok.then(|| ext.to_ascii_lowercase())
}

const MEDIA_EXTS: [&str; 13] = ["ts", "m4s", "mp4", "m4v", "m4a", "aac", "mp3", "ac3", "ec3", "vtt", "webvtt", "cmfv", "cmfa"];

/// The local name of entry `id`: `index.m3u8` for the entry playlist,
/// `p<id>.m3u8`, `r<id>.<ext>`, `k<id>.key`, `m<id>.<ext>`, `f<id>.<ext>`.
/// Segment extensions come from the upstream path when it is a media one
/// (CDNs that disguise segments as images get `ts`).
pub(crate) fn local_name(id: usize, role: Role, url: &str) -> String {
    let media = || path_ext(url).filter(|e| MEDIA_EXTS.contains(&e.as_str()));
    match role {
        Role::Playlist if id == 0 => "index.m3u8".to_owned(),
        Role::Playlist => format!("p{id}.m3u8"),
        Role::Key => format!("k{id}.key"),
        Role::Segment => format!("r{id}.{}", media().unwrap_or_else(|| "ts".into())),
        Role::Map => format!("m{id}.{}", media().unwrap_or_else(|| "mp4".into())),
        Role::File => format!(
            "f{id}.{}",
            path_ext(url).filter(|e| ["mp4", "m4v", "mov", "webm", "mkv"].contains(&e.as_str())).unwrap_or_else(|| "mp4".into())
        ),
    }
}

/// A local name back to (id, role letter): `index.m3u8` is (0, 'p').
pub(crate) fn parse_name(name: &str) -> Option<(usize, char)> {
    if name == "index.m3u8" {
        return Some((0, 'p'));
    }
    let mut chars = name.chars();
    let letter = chars.next()?;
    if !"prkmf".contains(letter) {
        return None;
    }
    let rest = chars.as_str();
    let (digits, ext) = rest.split_once('.')?;
    if digits.is_empty() || digits.len() > 9 || !digits.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    if ext.is_empty() || ext.len() > 6 || !ext.bytes().all(|b| b.is_ascii_alphanumeric()) {
        return None;
    }
    Some((digits.parse().ok()?, letter))
}

/// True when `text` is an HLS playlist (`#EXTM3U` first, BOM and blank
/// space allowed before it).
pub(crate) fn is_playlist(text: &str) -> bool {
    text.trim_start_matches('\u{feff}').trim_start().starts_with("#EXTM3U")
}

/// The same rule as the downloader's (`dl::hls`): any key method other
/// than NONE / AES-128 with identity keys is DRM.
pub(crate) fn is_drm_key(t: &str) -> bool {
    let method = attr(t, "METHOD").unwrap_or_default().to_ascii_uppercase();
    if method == "NONE" {
        return false;
    }
    if method != "AES-128" {
        return true;
    }
    attr(t, "KEYFORMAT").is_some_and(|f| f != "identity")
}

/// `line` with its `URI` attribute's value `uri` replaced by `local`
/// (quoted as found).
fn replace_uri(line: &str, uri: &str, local: &str) -> String {
    let quoted = format!("URI=\"{uri}\"");
    if line.contains(&quoted) {
        return line.replacen(&quoted, &format!("URI=\"{local}\""), 1);
    }
    line.replacen(&format!("URI={uri}"), &format!("URI=\"{local}\""), 1)
}

fn resolution(t: &str) -> (u32, u32) {
    attr(t, "RESOLUTION")
        .and_then(|r| {
            let (w, h) = r.split_once(['x', 'X'])?;
            Some((w.trim().parse().ok()?, h.trim().parse().ok()?))
        })
        .unwrap_or((0, 0))
}

fn bandwidth(t: &str) -> u64 {
    attr(t, "BANDWIDTH").and_then(|b| b.parse().ok()).unwrap_or(0)
}

/// Playlist `text` (entry `me` of the table, fetched from `base`, its final
/// URL) with every URI replaced by a local name.
pub(crate) fn rewrite(text: &str, base: &str, me: usize, table: &mut dyn Table) -> Result<String, RewriteError> {
    if !is_playlist(text) {
        return Err(RewriteError::NotPlaylist);
    }
    // DRM first: nothing is registered for a playlist that cannot play.
    for raw in text.split('\n') {
        let t = raw.trim();
        if (t.starts_with("#EXT-X-KEY:") || t.starts_with("#EXT-X-SESSION-KEY:")) && is_drm_key(t) {
            return Err(RewriteError::Drm);
        }
    }
    table.begin(me);
    let is_master = text.contains("#EXT-X-STREAM-INF")
        || text.contains("#EXT-X-I-FRAME-STREAM-INF")
        || text.contains("#EXT-X-MEDIA:");
    let mut seq: u64 = 0;
    let mut segments: u64 = 0;
    let mut clock = 0.0f64;
    let mut extinf: Option<f64> = None;
    let (mut variants, mut iframes, mut renditions, mut keys, mut maps) = (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut pending: Option<Desc> = None;
    let mut out: Vec<String> = Vec::new();
    let tagged = |t: &str, desc: Desc, role: Role, table: &mut dyn Table| -> String {
        match attr(t, "URI") {
            Some(uri) if !uri.is_empty() => {
                let name = table.register(me, desc, resolve(&uri, base), role);
                replace_uri(t, &uri, &name)
            }
            _ => t.to_owned(),
        }
    };
    for raw in text.split('\n') {
        let t = raw.strip_suffix('\r').unwrap_or(raw).trim();
        if t.is_empty() {
            continue;
        }
        if let Some(v) = t.strip_prefix("#EXT-X-MEDIA-SEQUENCE:") {
            seq = v.trim().parse().unwrap_or(0);
            out.push(t.to_owned());
            continue;
        }
        if let Some(v) = t.strip_prefix("#EXTINF:") {
            extinf = v.split(',').next().and_then(|d| d.trim().parse::<f64>().ok()).filter(|d| d.is_finite() && *d >= 0.0);
            out.push(t.to_owned());
            continue;
        }
        if t.starts_with("#EXT-X-KEY:") || t.starts_with("#EXT-X-SESSION-KEY:") {
            let path = attr(t, "URI").map(|u| Manifest::path_key(&resolve(&u, base))).unwrap_or_default();
            if attr(t, "URI").is_some() {
                keys += 1;
            }
            out.push(tagged(t, Desc::Key { path, ord: keys.saturating_sub(1) }, Role::Key, table));
            continue;
        }
        if t.starts_with("#EXT-X-MAP:") {
            let path = attr(t, "URI").map(|u| Manifest::path_key(&resolve(&u, base))).unwrap_or_default();
            let desc = Desc::Map { path, range: attr(t, "BYTERANGE").unwrap_or_default(), ord: maps };
            maps += 1;
            out.push(tagged(t, desc, Role::Map, table));
            continue;
        }
        if t.starts_with("#EXT-X-MEDIA:") {
            let desc = Desc::Rendition {
                kind: attr(t, "TYPE").unwrap_or_default(),
                lang: attr(t, "LANGUAGE").unwrap_or_default().to_ascii_lowercase(),
                name: attr(t, "NAME").unwrap_or_default(),
                ord: renditions,
            };
            renditions += 1;
            out.push(tagged(t, desc, Role::Playlist, table));
            continue;
        }
        if t.starts_with("#EXT-X-I-FRAME-STREAM-INF:") {
            let (w, h) = resolution(t);
            let desc = Desc::IFrame { bw: bandwidth(t), w, h, ord: iframes };
            iframes += 1;
            out.push(tagged(t, desc, Role::Playlist, table));
            continue;
        }
        if t.starts_with("#EXT-X-STREAM-INF:") {
            let (w, h) = resolution(t);
            pending = Some(Desc::Variant { bw: bandwidth(t), w, h, codecs: attr(t, "CODECS").unwrap_or_default(), ord: variants });
            variants += 1;
            out.push(t.to_owned());
            continue;
        }
        if t.starts_with("#EXT-X-PART:")
            || t.starts_with("#EXT-X-PART-INF:")
            || t.starts_with("#EXT-X-PRELOAD-HINT:")
            || t.starts_with("#EXT-X-RENDITION-REPORT:")
            || t.starts_with("#EXT-X-SERVER-CONTROL:")
            || (t.starts_with("#EXT-X-SESSION-DATA:") && attr(t, "URI").is_some())
        {
            continue;
        }
        if t.starts_with('#') {
            out.push(t.to_owned());
            continue;
        }
        // A bare URI: a variant (master) or a segment.
        let abs = resolve(t, base);
        if is_master || pending.is_some() {
            let desc = pending.take().unwrap_or_else(|| {
                variants += 1;
                Desc::Variant { bw: 0, w: 0, h: 0, codecs: String::new(), ord: variants - 1 }
            });
            out.push(table.register(me, desc, abs, Role::Playlist));
        } else {
            let dur = extinf.take().unwrap_or(0.0);
            let desc = Desc::Segment { seq: seq + segments, start: clock, dur };
            clock += dur;
            segments += 1;
            out.push(table.register(me, desc, abs, Role::Segment));
        }
    }
    let mut s = out.join("\n");
    s.push('\n');
    Ok(s)
}

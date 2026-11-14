//! HLS planning, the same as the iPhone's (`HlsPlanner` / `HlsManifest` in
//! `ios/Rustflix/HlsDownloader.swift`):
//!
//! - [`Planner`] walks a playlist tree (master → the best variant and the
//!   renditions it uses) and produces a [`Manifest`]: every resource
//!   (segment, AES-128 key, init map) to fetch, plus the playlists with
//!   placeholders that are later replaced by local file names.
//! - [`Manifest`] is persisted in the record's folder (`.manifest.json`)
//!   so a download continues with only what is missing, and
//!   [`Manifest::adopt`] maps the resources of a re-read playlist (a fresh
//!   signed link) onto the ones already saved.
//!
//! Byte-range segments (`EXT-X-BYTERANGE`, `EXT-X-MAP:…BYTERANGE=`) work:
//! a resource is one URL fetched whole, so the ranges in the local
//! playlist still point into the same bytes.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, PartialEq)]
pub(crate) enum HlsError {
    /// A playlist answered this status (after retries for 5xx/429).
    Http(u16),
    /// SAMPLE-AES / FairPlay / Widevine: cannot be downloaded.
    Drm,
    /// Not a playlist (an error page, binary data).
    NotText,
    BadUrl(String),
    /// No segments.
    Empty,
    /// The network failed (after retries).
    Network(String),
    /// The download was stopped meanwhile.
    Stopped,
}

impl HlsError {
    /// The record's `reason` for this failure.
    pub(crate) fn reason(&self) -> &'static str {
        match self {
            HlsError::Http(code) if super::policy::is_auth_status(*code) => "expired",
            HlsError::Drm => "drm",
            _ => "failed",
        }
    }

    pub(crate) fn message(&self) -> String {
        match self {
            HlsError::Http(code) if super::policy::is_auth_status(*code) => {
                "link expired — open the episode again to continue".into()
            }
            HlsError::Http(code) => format!("HTTP {code} for the playlist"),
            HlsError::Drm => "DRM-protected stream can't be downloaded".into(),
            HlsError::NotText => "playlist is not text".into(),
            HlsError::BadUrl(_) => "bad playlist url".into(),
            HlsError::Empty => "playlist has no segments".into(),
            HlsError::Network(m) => format!("network error: {m}"),
            HlsError::Stopped => "stopped".into(),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Resource {
    /// Absolute remote URL (signed; replaced when the playlist is re-read).
    pub url: String,
    /// Local base name ("f12"); the sniffed extension is appended on disk.
    pub file: String,
    #[serde(default)]
    pub ext: Option<String>,
    #[serde(default)]
    pub done: bool,
    #[serde(default)]
    pub bytes: u64,
    /// Index of the playlist that first referenced this resource.
    pub playlist: usize,
    /// Kind + ordinal inside that playlist: "s17" segment, "k0" key, "m0" map.
    pub slot: String,
}

impl Resource {
    pub(crate) fn local_name(&self) -> String {
        match &self.ext {
            Some(e) => format!("{}.{e}", self.file),
            None => self.file.clone(),
        }
    }

    pub(crate) fn kind(&self) -> char {
        self.slot.chars().next().unwrap_or('s')
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub(crate) struct Playlist {
    pub remote: String,
    pub local: String,
    /// Rewritten lines; resources appear as [`token`].
    pub lines: Vec<String>,
    /// Identity across re-reads: the variant / rendition attributes plus
    /// the segment count.
    pub signature: String,
}

#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Manifest {
    pub version: u32,
    /// The link it was planned from: a record whose link changed re-reads
    /// the playlists (and maps what is saved onto them).
    #[serde(default)]
    pub source: String,
    pub playlists: Vec<Playlist>,
    pub resources: Vec<Resource>,
    pub next_name: usize,
}

/// Placeholder of resource `idx` in a playlist line.
pub(crate) fn token(idx: usize) -> String {
    format!("\u{1}R{idx}\u{1}")
}

/// The local name of playlist `idx`: the entry is `index.m3u8`.
fn playlist_name(idx: usize) -> String {
    if idx == 0 { "index.m3u8".into() } else { format!("p{idx}.m3u8") }
}

/// Extensions a saved resource can have on disk (see [`sniff_ext`]).
const EXTS: [Option<&str>; 7] = [Some("ts"), Some("m4s"), Some("aac"), Some("vtt"), Some("key"), Some("mp4"), None];

impl Manifest {
    pub(crate) fn entry(&self) -> String {
        self.playlists.first().map(|p| p.local.clone()).unwrap_or_else(|| playlist_name(0))
    }

    pub(crate) fn done_count(&self) -> usize {
        self.resources.iter().filter(|r| r.done).count()
    }

    pub(crate) fn done_bytes(&self) -> u64 {
        self.resources.iter().filter(|r| r.done).map(|r| r.bytes).sum()
    }

    pub(crate) fn is_complete(&self) -> bool {
        !self.resources.is_empty() && self.resources.iter().all(|r| r.done)
    }

    /// URL path without host/query — signed URLs change their query (and
    /// sometimes the edge host) between reads.
    pub(crate) fn path_key(url: &str) -> String {
        match url::Url::parse(url) {
            Ok(u) => u.path().to_owned(),
            Err(_) => url.to_owned(),
        }
    }

    /// Gives every resource a local name. Resources that match one of
    /// `old` (same playlist signature, then a unique URL path, else the
    /// same kind+ordinal) keep its name and done state, so saved segments
    /// are not fetched again. New names never reuse a name of `old` or of
    /// a file already on disk (`start_name`).
    pub(crate) fn adopt(&mut self, old: Option<&Manifest>, start_name: usize) {
        let mut next = start_name.max(old.map_or(0, |o| o.next_name)).max(self.next_name);
        let mut partner: HashMap<usize, usize> = HashMap::new();
        if let Some(old) = old {
            let mut used = HashSet::new();
            for (pi, p) in self.playlists.iter().enumerate() {
                if pi < old.playlists.len() && old.playlists[pi].signature == p.signature && !used.contains(&pi) {
                    partner.insert(pi, pi);
                    used.insert(pi);
                    continue;
                }
                if let Some(qi) = (0..old.playlists.len())
                    .find(|q| !used.contains(q) && old.playlists[*q].signature == p.signature)
                {
                    partner.insert(pi, qi);
                    used.insert(qi);
                }
            }
        }
        let mut old_paths: HashMap<usize, HashMap<String, Vec<usize>>> = HashMap::new();
        let mut old_slots: HashMap<usize, HashMap<String, usize>> = HashMap::new();
        if let Some(old) = old {
            for (j, r) in old.resources.iter().enumerate() {
                old_paths.entry(r.playlist).or_default().entry(Self::path_key(&r.url)).or_default().push(j);
                old_slots.entry(r.playlist).or_default().insert(r.slot.clone(), j);
            }
        }
        let mut new_paths: HashMap<usize, HashMap<String, usize>> = HashMap::new();
        for r in &self.resources {
            *new_paths.entry(r.playlist).or_default().entry(Self::path_key(&r.url)).or_default() += 1;
        }
        let mut taken = HashSet::new();
        for i in 0..self.resources.len() {
            let mut matched = None;
            if let (Some(old), Some(q)) = (old, partner.get(&self.resources[i].playlist)) {
                let r = &self.resources[i];
                let p = Self::path_key(&r.url);
                let unique_new = new_paths.get(&r.playlist).and_then(|m| m.get(&p)) == Some(&1);
                let by_path = old_paths
                    .get(q)
                    .and_then(|m| m.get(&p))
                    .filter(|js| js.len() == 1 && old.resources[js[0]].kind() == r.kind())
                    .map(|js| js[0]);
                matched = if unique_new && by_path.is_some() {
                    by_path
                } else {
                    old_slots.get(q).and_then(|m| m.get(&r.slot)).copied()
                };
                if matched.is_some_and(|j| taken.contains(&j)) {
                    matched = None;
                }
            }
            let r = &mut self.resources[i];
            match (old, matched) {
                (Some(old), Some(j)) => {
                    taken.insert(j);
                    let o = &old.resources[j];
                    r.file = o.file.clone();
                    r.ext = o.ext.clone();
                    r.done = o.done;
                    r.bytes = o.bytes;
                }
                _ => {
                    r.file = format!("f{next}");
                    r.ext = None;
                    r.done = false;
                    r.bytes = 0;
                    next += 1;
                }
            }
        }
        self.next_name = next;
    }

    /// Files on disk are the truth: a resource whose file exists was saved
    /// (a file only gets its final name once complete and checked).
    pub(crate) fn mark_from_disk(&mut self, names: &HashSet<String>, size: impl Fn(&str) -> u64) {
        for r in self.resources.iter_mut().filter(|r| !r.done) {
            for ext in EXTS {
                let n = match ext {
                    Some(e) => format!("{}.{e}", r.file),
                    None => r.file.clone(),
                };
                if names.contains(&n) {
                    r.ext = ext.map(str::to_owned);
                    r.done = true;
                    r.bytes = size(&n);
                    break;
                }
            }
        }
    }

    /// Final text of playlist `pi`, placeholders replaced by local names.
    pub(crate) fn render(&self, pi: usize) -> String {
        let Some(p) = self.playlists.get(pi) else { return String::new() };
        let mut out: Vec<String> = Vec::with_capacity(p.lines.len());
        for line in &p.lines {
            if !line.contains("\u{1}R") {
                out.push(line.clone());
                continue;
            }
            let mut s = String::new();
            let mut rest = line.as_str();
            while let Some(a) = rest.find("\u{1}R") {
                s.push_str(&rest[..a]);
                let after = &rest[a + 2..];
                let Some(b) = after.find('\u{1}') else {
                    s.push_str(after);
                    rest = "";
                    break;
                };
                match after[..b].parse::<usize>().ok().and_then(|i| self.resources.get(i)) {
                    Some(r) => s.push_str(&r.local_name()),
                    None => s.push_str(&after[..b]),
                }
                rest = &after[b + 1..];
            }
            s.push_str(rest);
            out.push(s);
        }
        out.join("\n")
    }

    /// Every local file a finished download needs.
    pub(crate) fn referenced_files(&self) -> HashSet<String> {
        self.resources
            .iter()
            .map(Resource::local_name)
            .chain(self.playlists.iter().map(|p| p.local.clone()))
            .collect()
    }
}

/// `KEY="value"` attribute (quoted, or a bare token up to a comma), matched
/// at an attribute boundary so "URI" does not hit "X-URI".
pub(crate) fn attr(line: &str, key: &str) -> Option<String> {
    let pat = format!("{key}=");
    let mut from = 0;
    while let Some(off) = line[from..].find(&pat) {
        let at = from + off;
        let ok = at == 0 || matches!(line.as_bytes()[at - 1], b',' | b':');
        if !ok {
            from = at + pat.len();
            continue;
        }
        let s = &line[at + pat.len()..];
        if let Some(q) = s.strip_prefix('"') {
            return q.find('"').map(|end| q[..end].to_owned());
        }
        let end = s.find(',').unwrap_or(s.len());
        return Some(s[..end].trim().to_owned());
    }
    None
}

/// A playlist URI (relative or absolute) against its playlist's URL.
pub(crate) fn resolve(uri: &str, base: &str) -> String {
    let lower = uri.to_ascii_lowercase();
    if lower.starts_with("http://") || lower.starts_with("https://") {
        return uri.to_owned();
    }
    match url::Url::parse(base).and_then(|b| b.join(uri)) {
        Ok(u) => u.to_string(),
        Err(_) => uri.to_owned(),
    }
}

/// Container sniff: MPEG-TS sync byte, ADTS AAC, WebVTT, otherwise fMP4.
pub(crate) fn sniff_ext(head: &[u8]) -> Option<&'static str> {
    if head.starts_with(b"WEBVTT") || head.starts_with(b"\xEF\xBB\xBFWEBVTT") {
        return Some("vtt");
    }
    if head.len() <= 8 {
        return None;
    }
    if head[0] == 0x47 {
        return Some("ts");
    }
    if head[0] == 0xFF && (head[1] & 0xF0) == 0xF0 {
        return Some("aac");
    }
    match &head[4..8] {
        b"ftyp" | b"styp" | b"moof" | b"moov" | b"sidx" => Some("m4s"),
        _ => None,
    }
}

/// Some edges answer 200 with a small HTML error page instead of media.
pub(crate) fn looks_like_error_page(head: &[u8], size: u64) -> bool {
    if size >= 4096 {
        return false;
    }
    let s = String::from_utf8_lossy(&head[..head.len().min(256)]).to_ascii_lowercase();
    s.contains("<html") || s.contains("<!doctype") || s.contains("<head")
}

fn is_drm_key(t: &str) -> bool {
    let method = attr(t, "METHOD").unwrap_or_default().to_ascii_uppercase();
    if method == "NONE" {
        return false;
    }
    if method != "AES-128" {
        // SAMPLE-AES, SAMPLE-AES-CTR, SAMPLE-AES-CENC, FairPlay's ...
        return true;
    }
    // AES-128 with a key system other than plain "identity" keys.
    attr(t, "KEYFORMAT").is_some_and(|f| f != "identity")
}

/// Walks a playlist tree with `fetch` (the playlist text of a URL).
pub(crate) struct Planner<'a> {
    fetch: &'a mut dyn FnMut(&str) -> Result<String, HlsError>,
    playlists: Vec<Playlist>,
    resources: Vec<Resource>,
    by_url: HashMap<String, usize>,
    counters: HashMap<(usize, char), usize>,
}

/// Highest variant bandwidth kept (bits/s).
pub(crate) const BANDWIDTH_CAP: u64 = 15_000_000;

struct Variant {
    uri: String,
    bandwidth: u64,
    pixels: u64,
    audio: Option<String>,
    subtitles: Option<String>,
}

fn pixels(res: Option<String>) -> u64 {
    res.and_then(|r| {
        let (w, h) = r.split_once(['x', 'X'])?;
        Some(w.trim().parse::<u64>().ok()? * h.trim().parse::<u64>().ok()?)
    })
    .unwrap_or(0)
}

/// The variant to keep: the highest bandwidth (then resolution) under the
/// cap, else the lowest.
fn choose(variants: &[Variant]) -> Option<&Variant> {
    variants
        .iter()
        .filter(|v| v.bandwidth <= BANDWIDTH_CAP)
        .max_by_key(|v| (v.bandwidth, v.pixels))
        .or_else(|| variants.iter().min_by_key(|v| (v.bandwidth, std::cmp::Reverse(v.pixels))))
}

impl<'a> Planner<'a> {
    pub(crate) fn new(fetch: &'a mut dyn FnMut(&str) -> Result<String, HlsError>) -> Self {
        Planner {
            fetch,
            playlists: Vec::new(),
            resources: Vec::new(),
            by_url: HashMap::new(),
            counters: HashMap::new(),
        }
    }

    pub(crate) fn plan(mut self, url: &str) -> Result<Manifest, HlsError> {
        let text = (self.fetch)(url)?;
        self.walk(&text, url, "root")?;
        if self.resources.is_empty() {
            return Err(HlsError::Empty);
        }
        Ok(Manifest {
            version: 1,
            source: url.to_owned(),
            playlists: self.playlists,
            resources: self.resources,
            next_name: 0,
        })
    }

    fn register(&mut self, abs: String, playlist: usize, kind: char) -> usize {
        if let Some(&i) = self.by_url.get(&abs) {
            return i;
        }
        let ord = self.counters.entry((playlist, kind)).or_insert(0);
        let slot = format!("{kind}{ord}");
        *ord += 1;
        self.resources.push(Resource {
            url: abs.clone(),
            file: String::new(),
            ext: None,
            done: false,
            bytes: 0,
            playlist,
            slot,
        });
        self.by_url.insert(abs, self.resources.len() - 1);
        self.resources.len() - 1
    }

    fn walk(&mut self, text: &str, remote: &str, role: &str) -> Result<usize, HlsError> {
        if self.playlists.len() > 64 {
            return Err(HlsError::NotText);
        }
        let my = self.playlists.len();
        self.playlists.push(Playlist {
            remote: remote.to_owned(),
            local: playlist_name(my),
            lines: Vec::new(),
            signature: String::new(),
        });
        let mut lines: Vec<String> = text
            .split('\n')
            .map(|l| l.strip_suffix('\r').unwrap_or(l).to_owned())
            .collect();
        let is_master = text.contains("#EXT-X-STREAM-INF")
            || text.contains("#EXT-X-I-FRAME-STREAM-INF")
            || text.contains("#EXT-X-MEDIA:");

        // Master: exactly one variant plus the renditions it uses.
        let mut keep_uri: Option<String> = None;
        let mut keep_groups: Option<HashSet<(String, String)>> = None;
        if is_master {
            let mut variants = Vec::new();
            for (i, l) in lines.iter().enumerate() {
                let t = l.trim();
                if !t.starts_with("#EXT-X-STREAM-INF:") {
                    continue;
                }
                if let Some(u) = lines[i + 1..].iter().map(|x| x.trim()).find(|x| !x.is_empty())
                    && !u.starts_with('#')
                {
                    variants.push(Variant {
                        uri: resolve(u, remote),
                        bandwidth: attr(t, "BANDWIDTH").and_then(|b| b.parse().ok()).unwrap_or(0),
                        pixels: pixels(attr(t, "RESOLUTION")),
                        audio: attr(t, "AUDIO"),
                        subtitles: attr(t, "SUBTITLES"),
                    });
                }
            }
            if let Some(v) = choose(&variants) {
                keep_uri = Some(v.uri.clone());
                let mut g = HashSet::new();
                if let Some(a) = &v.audio {
                    g.insert(("AUDIO".to_owned(), a.clone()));
                }
                if let Some(s) = &v.subtitles {
                    g.insert(("SUBTITLES".to_owned(), s.clone()));
                }
                keep_groups = Some(g);
            }
        }

        let mut pending_inf: Option<usize> = None;
        let mut pending_attrs = String::new();
        let mut seg_lines = 0usize;
        let mut kept_variant = false;
        let mut has_endlist = false;
        for i in 0..lines.len() {
            let raw = lines[i].clone();
            let t = raw.trim();
            if t.is_empty() {
                continue;
            }
            if t.starts_with("#EXT-X-KEY:") || t.starts_with("#EXT-X-SESSION-KEY:") {
                if is_drm_key(t) {
                    return Err(HlsError::Drm);
                }
                if t.starts_with("#EXT-X-SESSION-KEY:") {
                    lines[i].clear();
                    continue;
                }
                if let Some(uri) = attr(t, "URI") {
                    let idx = self.register(resolve(&uri, remote), my, 'k');
                    lines[i] = raw.replace(&format!("URI=\"{uri}\""), &format!("URI=\"{}\"", token(idx)));
                }
                continue;
            }
            if t.starts_with("#EXT-X-MAP:") {
                if let Some(uri) = attr(t, "URI") {
                    let idx = self.register(resolve(&uri, remote), my, 'm');
                    lines[i] = raw.replace(&format!("URI=\"{uri}\""), &format!("URI=\"{}\"", token(idx)));
                }
                continue;
            }
            if t.starts_with("#EXT-X-I-FRAME-STREAM-INF:")
                || t.starts_with("#EXT-X-SESSION-DATA:")
                || t.starts_with("#EXT-X-PART:")
                || t.starts_with("#EXT-X-PRELOAD-HINT:")
                || t.starts_with("#EXT-X-RENDITION-REPORT:")
            {
                // Trickplay, session data, low-latency parts: not needed
                // offline (and they would reach the network).
                lines[i].clear();
                continue;
            }
            if t.starts_with("#EXT-X-MEDIA:") {
                if let Some(uri) = attr(t, "URI") {
                    let kind = attr(t, "TYPE").unwrap_or_default();
                    let group = attr(t, "GROUP-ID").unwrap_or_default();
                    let wanted = keep_groups.as_ref().is_none_or(|g| g.contains(&(kind.clone(), group)));
                    if wanted {
                        let abs = resolve(&uri, remote);
                        let sig = ["TYPE", "GROUP-ID", "NAME", "LANGUAGE"]
                            .map(|k| attr(t, k).unwrap_or_default())
                            .join(",");
                        let sub = self.sub_playlist(&abs, &format!("media:{sig}"))?;
                        lines[i] = raw.replace(&format!("URI=\"{uri}\""), &format!("URI=\"{sub}\""));
                    } else {
                        lines[i].clear();
                    }
                }
                continue;
            }
            if t.starts_with('#') {
                if t.starts_with("#EXT-X-STREAM-INF") {
                    pending_inf = Some(i);
                    pending_attrs = ["BANDWIDTH", "RESOLUTION", "CODECS"]
                        .map(|k| attr(t, k).unwrap_or_default())
                        .join(",");
                }
                if t == "#EXT-X-ENDLIST" {
                    has_endlist = true;
                }
                continue;
            }
            // A bare URI: a variant playlist (master) or a segment.
            let abs = resolve(t, remote);
            if is_master || pending_inf.is_some() {
                if keep_uri.as_deref().is_none_or(|k| k == abs) && !kept_variant {
                    kept_variant = true;
                    lines[i] = self.sub_playlist(&abs, &format!("variant:{pending_attrs}"))?;
                } else {
                    // Unselected variants go entirely, so the offline
                    // player never switches to a remote rendition.
                    lines[i].clear();
                    if let Some(p) = pending_inf {
                        lines[p].clear();
                    }
                }
                pending_inf = None;
            } else {
                let idx = self.register(abs, my, 's');
                lines[i] = token(idx);
                seg_lines += 1;
            }
        }
        if !is_master && seg_lines > 0 && !has_endlist {
            // A live/event playlist: the local copy is complete.
            lines.push("#EXT-X-ENDLIST".into());
        }
        lines.retain(|l| !l.is_empty());
        self.playlists[my].lines = lines;
        self.playlists[my].signature = format!("{role}|n={seg_lines}");
        Ok(my)
    }

    fn sub_playlist(&mut self, abs: &str, role: &str) -> Result<String, HlsError> {
        let text = (self.fetch)(abs)?;
        let idx = self.walk(&text, abs, role)?;
        Ok(self.playlists[idx].local.clone())
    }
}

/// First "f<N>" index not used by any name in `names`.
pub(crate) fn next_index<'a>(names: impl IntoIterator<Item = &'a String>) -> usize {
    let mut max: Option<usize> = None;
    for n in names {
        let Some(rest) = n.strip_prefix('f') else { continue };
        let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
        if let Ok(v) = digits.parse::<usize>() {
            max = Some(max.map_or(v, |m| m.max(v)));
        }
    }
    max.map_or(0, |m| m + 1)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan_with(map: &[(&str, &str)], url: &str) -> Result<Manifest, HlsError> {
        let map: HashMap<String, String> = map.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect();
        let mut fetch = |u: &str| map.get(u).cloned().ok_or(HlsError::Http(404));
        Planner::new(&mut fetch).plan(url)
    }

    const MASTER: &str = "#EXTM3U\r\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"aud\",NAME=\"English\",LANGUAGE=\"en\",DEFAULT=YES,URI=\"audio/en.m3u8\"\r\n\
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID=\"other\",NAME=\"X\",URI=\"audio/other.m3u8\"\r\n\
#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=640x360,AUDIO=\"aud\"\r\n\
low/index.m3u8?token=abc\r\n\
#EXT-X-STREAM-INF:BANDWIDTH=5000000,RESOLUTION=1920x1080,AUDIO=\"aud\"\r\n\
https://cdn2.example.com/hi/index.m3u8\r\n\
#EXT-X-STREAM-INF:BANDWIDTH=30000000,RESOLUTION=3840x2160,AUDIO=\"aud\"\r\n\
uhd/index.m3u8\r\n\
#EXT-X-I-FRAME-STREAM-INF:BANDWIDTH=100000,URI=\"iframes.m3u8\"\r\n";

    const HI: &str = "#EXTM3U\n#EXT-X-TARGETDURATION:6\n\
#EXT-X-KEY:METHOD=AES-128,URI=\"/keys/k1?sig=1\",IV=0x01\n\
#EXT-X-MAP:URI=\"init.mp4\"\n\
#EXTINF:6,\nseg0.m4s?sig=1\n#EXTINF:6,\n../hi/seg1.m4s?sig=1\n#EXTINF:6,\n?part=3\n#EXT-X-ENDLIST\n";

    const AUDIO: &str = "#EXTM3U\n#EXTINF:6,\na0.aac\n#EXTINF:6,\na1.aac\n#EXT-X-ENDLIST\n";

    fn sample() -> Manifest {
        plan_with(
            &[
                ("https://cdn.example.com/v/master.m3u8", MASTER),
                ("https://cdn2.example.com/hi/index.m3u8", HI),
                ("https://cdn.example.com/v/audio/en.m3u8", AUDIO),
            ],
            "https://cdn.example.com/v/master.m3u8",
        )
        .unwrap()
    }

    #[test]
    fn plans_a_master_playlist() {
        let mut m = sample();
        // Root, the chosen variant (5 Mbps under the cap) and its audio group only.
        assert_eq!(m.playlists.len(), 3);
        assert_eq!(m.playlists[0].local, "index.m3u8");
        assert_eq!(m.playlists[1].remote, "https://cdn.example.com/v/audio/en.m3u8");
        assert_eq!(m.playlists[2].remote, "https://cdn2.example.com/hi/index.m3u8");
        let urls: Vec<&str> = m.resources.iter().map(|r| r.url.as_str()).collect();
        assert_eq!(
            urls,
            [
                "https://cdn.example.com/v/audio/a0.aac",
                "https://cdn.example.com/v/audio/a1.aac",
                "https://cdn2.example.com/keys/k1?sig=1",
                "https://cdn2.example.com/hi/init.mp4",
                "https://cdn2.example.com/hi/seg0.m4s?sig=1",
                "https://cdn2.example.com/hi/seg1.m4s?sig=1",
                // A query-only name resolves against the playlist itself.
                "https://cdn2.example.com/hi/index.m3u8?part=3",
            ]
        );
        let slots: Vec<&str> = m.resources.iter().map(|r| r.slot.as_str()).collect();
        assert_eq!(slots, ["s0", "s1", "k0", "m0", "s0", "s1", "s2"]);
        m.adopt(None, 0);
        let root = m.render(0);
        assert!(!root.contains("low/") && !root.contains("uhd") && !root.contains("other") && !root.contains("FRAME"), "{root}");
        assert!(root.contains("URI=\"p1.m3u8\"") && root.contains("\np2.m3u8"), "{root}");
        assert!(!root.contains('\r'));
        let hi = m.render(2);
        assert!(hi.contains("#EXT-X-KEY:METHOD=AES-128,URI=\"f2\",IV=0x01"), "{hi}");
        assert!(hi.contains("#EXT-X-MAP:URI=\"f3\""), "{hi}");
        assert!(hi.contains("\nf4\n") && hi.ends_with("#EXT-X-ENDLIST"), "{hi}");
        assert!(!hi.contains("http"), "{hi}");
        assert_eq!(m.entry(), "index.m3u8");
    }

    #[test]
    fn variant_choice() {
        let v = |bw: u64, px: u64| Variant { uri: format!("{bw}/{px}"), bandwidth: bw, pixels: px, audio: None, subtitles: None };
        assert_eq!(choose(&[v(800, 1), v(5_000_000, 2), v(30_000_000, 3)]).unwrap().uri, "5000000/2");
        assert_eq!(choose(&[v(5_000_000, 1), v(5_000_000, 9)]).unwrap().uri, "5000000/9");
        // Everything above the cap: the lowest.
        assert_eq!(choose(&[v(40_000_000, 1), v(20_000_000, 2)]).unwrap().uri, "20000000/2");
        assert_eq!(pixels(Some("1920x1080".into())), 1920 * 1080);
    }

    #[test]
    fn media_playlist_and_endlist() {
        let m = plan_with(
            &[("http://h/a/b.m3u8", "#EXTM3U\n#EXTINF:4,\nhttp://other/x.ts\n#EXTINF:4,\n/abs/y.ts\n")],
            "http://h/a/b.m3u8",
        )
        .unwrap();
        assert_eq!(m.playlists.len(), 1);
        assert_eq!(m.resources[0].url, "http://other/x.ts");
        assert_eq!(m.resources[1].url, "http://h/abs/y.ts");
        assert!(m.playlists[0].lines.last().unwrap() == "#EXT-X-ENDLIST");
    }

    #[test]
    fn byte_range_segments_share_one_resource() {
        let text = "#EXTM3U\n#EXT-X-MAP:URI=\"all.mp4\",BYTERANGE=\"700@0\"\n\
#EXTINF:4,\n#EXT-X-BYTERANGE:1000@700\nall.mp4\n#EXTINF:4,\n#EXT-X-BYTERANGE:1000\nall.mp4\n#EXT-X-ENDLIST\n";
        let mut m = plan_with(&[("http://h/p.m3u8", text)], "http://h/p.m3u8").unwrap();
        assert_eq!(m.resources.len(), 1);
        m.adopt(None, 0);
        let out = m.render(0);
        assert!(out.contains("#EXT-X-MAP:URI=\"f0\",BYTERANGE=\"700@0\""), "{out}");
        assert!(out.contains("#EXT-X-BYTERANGE:1000@700\nf0\n"), "{out}");
    }

    #[test]
    fn rejects_drm() {
        for key in [
            "#EXT-X-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
            "#EXT-X-KEY:METHOD=SAMPLE-AES-CTR,URI=\"data:x\",KEYFORMAT=\"urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed\"",
            "#EXT-X-KEY:METHOD=AES-128,URI=\"k\",KEYFORMAT=\"com.apple.streamingkeydelivery\"",
            "#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,URI=\"skd://x\"",
        ] {
            let text = format!("#EXTM3U\n{key}\n#EXTINF:4,\na.ts\n");
            assert_eq!(plan_with(&[("http://h/p.m3u8", &text)], "http://h/p.m3u8"), Err(HlsError::Drm), "{key}");
        }
        // METHOD=NONE and plain AES-128 are fine.
        let ok = "#EXTM3U\n#EXT-X-KEY:METHOD=NONE\n#EXT-X-KEY:METHOD=AES-128,URI=\"k.bin\",KEYFORMAT=\"identity\"\n#EXTINF:4,\na.ts\n";
        assert_eq!(plan_with(&[("http://h/p.m3u8", ok)], "http://h/p.m3u8").unwrap().resources.len(), 2);
        assert_eq!(HlsError::Drm.reason(), "drm");
        assert_eq!(HlsError::Http(403).reason(), "expired");
        assert_eq!(HlsError::Http(404).reason(), "failed");
    }

    #[test]
    fn errors_propagate() {
        assert_eq!(plan_with(&[], "http://h/p.m3u8"), Err(HlsError::Http(404)));
        assert_eq!(plan_with(&[("http://h/p.m3u8", "#EXTM3U\n")], "http://h/p.m3u8"), Err(HlsError::Empty));
    }

    #[test]
    fn attributes() {
        let l = "#EXT-X-MEDIA:TYPE=AUDIO,X-URI=\"no\",URI=\"yes.m3u8\",NAME=\"a,b\"";
        assert_eq!(attr(l, "URI").as_deref(), Some("yes.m3u8"));
        assert_eq!(attr(l, "NAME").as_deref(), Some("a,b"));
        assert_eq!(attr(l, "TYPE").as_deref(), Some("AUDIO"));
        assert_eq!(attr(l, "GROUP-ID"), None);
        assert_eq!(resolve("../x/y.ts?a=1", "https://h/a/b/c.m3u8"), "https://h/a/x/y.ts?a=1");
        assert_eq!(resolve("//cdn/z.ts", "https://h/a.m3u8"), "https://cdn/z.ts");
    }

    #[test]
    fn segments_map_across_a_refreshed_link() {
        let mut old = sample();
        old.adopt(None, 0);
        for r in old.resources.iter_mut().take(5) {
            r.done = true;
            r.bytes = 10;
        }
        // The same stream re-signed: new queries, another edge host.
        let fresh = |sig: &str| {
            let hi = HI.replace("sig=1", sig);
            plan_with(
                &[
                    ("https://cdn.example.com/v/master.m3u8?t=2", &MASTER.replace("https://cdn2.example.com", "https://cdn3.example.com")),
                    ("https://cdn3.example.com/hi/index.m3u8", &hi),
                    ("https://cdn.example.com/v/audio/en.m3u8", AUDIO),
                ],
                "https://cdn.example.com/v/master.m3u8?t=2",
            )
            .unwrap()
        };
        let mut m = fresh("sig=2");
        m.adopt(Some(&old), 0);
        for (a, b) in m.resources.iter().zip(&old.resources) {
            assert_eq!(a.file, b.file, "{} kept its name", a.url);
            assert_eq!(a.done, b.done);
        }
        assert!(m.resources[4].url.contains("sig=2"));
        assert_eq!(m.next_name, old.next_name);

        // Segment names that change entirely (unique tokens per path) still
        // map by kind + position when the variant and the count match.
        let mut renamed = fresh("sig=3");
        for r in renamed.resources.iter_mut().filter(|r| r.url.contains("seg")) {
            r.url = r.url.replace("seg", "chunk");
        }
        renamed.adopt(Some(&old), 0);
        assert_eq!(renamed.resources[4].file, old.resources[4].file);
        assert!(renamed.resources[4].done);

        // A different segment count: a new variant signature, new names.
        let mut other = plan_with(
            &[("http://h/p.m3u8", "#EXTM3U\n#EXTINF:6,\nseg0.m4s\n#EXT-X-ENDLIST\n")],
            "http://h/p.m3u8",
        )
        .unwrap();
        other.adopt(Some(&old), 3);
        assert_eq!(other.resources[0].file, format!("f{}", old.next_name));
        assert!(!other.resources[0].done);
    }

    #[test]
    fn marks_saved_files_and_names() {
        let mut m = sample();
        m.adopt(None, 0);
        let names: HashSet<String> = ["f0.aac", "f2", "f4.m4s", "f9.ts", ".f5.part"].iter().map(|s| s.to_string()).collect();
        m.mark_from_disk(&names, |_| 42);
        let done: Vec<bool> = m.resources.iter().map(|r| r.done).collect();
        assert_eq!(done, [true, false, true, false, true, false, false]);
        assert_eq!(m.resources[4].local_name(), "f4.m4s");
        assert_eq!(m.done_bytes(), 126);
        assert_eq!(next_index(&names.iter().cloned().collect::<Vec<_>>()), 10);
        let refs = m.referenced_files();
        assert!(refs.contains("index.m3u8") && refs.contains("f4.m4s") && refs.contains("f6"));
    }

    #[test]
    fn manifest_round_trips() {
        let mut m = sample();
        m.adopt(None, 0);
        let json = serde_json::to_string(&m).unwrap();
        assert!(json.contains("\"nextName\":7"));
        let back: Manifest = serde_json::from_str(&json).unwrap();
        assert_eq!(back, m);
    }

    #[test]
    fn sniffing() {
        assert_eq!(sniff_ext(&[0x47, 0, 0, 0, 0, 0, 0, 0, 0, 0]), Some("ts"));
        assert_eq!(sniff_ext(b"\0\0\0\x18ftypiso6xxxx"), Some("m4s"));
        assert_eq!(sniff_ext(&[0xFF, 0xF1, 0, 0, 0, 0, 0, 0, 0, 0]), Some("aac"));
        assert_eq!(sniff_ext(b"WEBVTT\n\n"), Some("vtt"));
        assert_eq!(sniff_ext(b"0123456789abcdef"), None);
        assert!(looks_like_error_page(b"<!DOCTYPE html><title>403</title>", 40));
        assert!(!looks_like_error_page(b"<html>", 10_000));
    }
}

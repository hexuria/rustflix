//! Download records and where they live.
//!
//! - Records persist in `<data dir>/<app id>/rustflix-downloads.json` (the
//!   directory NSH keeps the app's `storage.json` in), written atomically
//!   (temp file + rename), together with the download folder in effect and
//!   the next id — so a folder change and the records it moved are one
//!   write.
//! - Every record has a folder of its own, `<download dir>/<safe name>/`,
//!   holding its media and its dot-files: `.rustflix-download` (the marker
//!   naming the record), `.manifest.json` (HLS, while unfinished),
//!   `.download.part` / `.f<N>.<epoch>.part` (transfers in progress).

use std::{
    collections::BTreeMap,
    fs,
    io::Write,
    path::{Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub(crate) const MARKER: &str = ".rustflix-download";
pub(crate) const MANIFEST: &str = ".manifest.json";
pub(crate) const FILE_PART: &str = ".download.part";

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Record {
    pub id: u64,
    pub name: String,
    /// running | done | error
    pub status: String,
    pub progress: Option<f64>,
    pub message: String,
    /// "file" | "hls"
    pub kind: String,
    pub url: String,
    /// Request headers; kept only while the record is not done.
    pub headers: Option<BTreeMap<String, String>>,
    /// The record's folder (absolute).
    pub folder: PathBuf,
    /// The media file's name in `folder` once done (`index.m3u8` for HLS).
    pub file: Option<String>,
    pub key: Option<String>,
    #[serde(rename = "type")]
    pub media_type: Option<String>,
    pub media_id: Option<i64>,
    pub season: Option<i64>,
    pub episode: Option<i64>,
    pub title: Option<String>,
    /// Milliseconds since the epoch.
    pub created_at: f64,
    /// Why a record is `error`: expired | failed | cancelled | space | drm.
    pub reason: Option<String>,
    pub bytes: Option<u64>,
    pub total_bytes: Option<u64>,
    pub seg_done: Option<u64>,
    pub seg_total: Option<u64>,
    /// Bumped on every (re)start: work of an older generation is stale.
    pub epoch: u64,
}

impl Record {
    /// The record as `dl.list` / `dl.event` give it to JS.
    pub(crate) fn json(&self) -> Value {
        let mut v = json!({
            "id": self.id,
            "name": self.name,
            "status": self.status,
            "progress": self.progress,
            "message": self.message,
            "kind": self.kind,
            "key": self.key,
            "type": self.media_type,
            "mediaId": self.media_id,
            "season": self.season,
            "episode": self.episode,
            "title": self.title,
            "createdAt": self.created_at,
            "reason": self.reason,
            "bytes": self.bytes,
            "totalBytes": self.total_bytes,
            "done": self.seg_done,
            "total": self.seg_total,
            "waiting": Value::Null,
            "dir": self.folder.to_string_lossy(),
        });
        if self.status == "done"
            && let Some(f) = &self.file
        {
            v["file"] = Value::String(self.folder.join(f).to_string_lossy().into_owned());
        }
        v
    }

    pub(crate) fn running(&self) -> bool {
        self.status == "running"
    }
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub(crate) struct Saved {
    pub v: u32,
    pub next_id: u64,
    /// The download folder in effect; empty: the default.
    pub dir: String,
    /// The folder was chosen (by the user or adopted from an older build).
    pub configured: bool,
    pub records: Vec<Record>,
}

/// Reads the store; a missing or unreadable one is empty (an unreadable
/// one is set aside as `.corrupt`).
pub(crate) fn load(path: &Path) -> Saved {
    let Ok(text) = fs::read_to_string(path) else { return Saved::default() };
    match serde_json::from_str::<Saved>(&text) {
        Ok(s) => s,
        Err(e) => {
            log::warn!("dl: {} is unreadable ({e}); starting empty", path.display());
            let _ = fs::rename(path, path.with_extension("json.corrupt"));
            Saved::default()
        }
    }
}

/// Writes `bytes` to `path` atomically (temp file in the same folder,
/// flushed, renamed over).
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> std::io::Result<()> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir)?;
    }
    let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("file");
    let tmp = path.with_file_name(format!(".{name}.{}.tmp", std::process::id()));
    {
        let mut f = fs::File::create(&tmp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
    }
    fs::rename(&tmp, path).inspect_err(|_| {
        let _ = fs::remove_file(&tmp);
    })
}

pub(crate) fn save(path: &Path, saved: &Saved) -> std::io::Result<()> {
    let bytes = serde_json::to_vec(saved).map_err(std::io::Error::other)?;
    write_atomic(path, &bytes)
}

/// A file/folder name from a record's name: no path separators or
/// characters Finder/HFS or URLs trip on, no leading dots, at most 100
/// characters; "video" when nothing is left.
pub(crate) fn safe_name(name: &str) -> String {
    let mapped: String = name
        .chars()
        .map(|c| if c.is_control() || "/\\:*?\"<>|%#".contains(c) { '-' } else { c })
        .collect();
    let trimmed = mapped.trim().trim_start_matches(['.', ' ']).trim_end_matches(['.', ' ']);
    let cut: String = trimmed.chars().take(100).collect();
    let cut = cut.trim_end_matches(['.', ' ']).to_owned();
    if cut.is_empty() { "video".into() } else { cut }
}

/// A folder for a new record in `dir`: `<safe name>`, else `<safe name>
/// (2)`, `(3)`, … — never an existing entry.
pub(crate) fn unique_folder(dir: &Path, name: &str) -> PathBuf {
    let base = safe_name(name);
    let first = dir.join(&base);
    if fs::symlink_metadata(&first).is_err() {
        return first;
    }
    for n in 2..10_000 {
        let p = dir.join(format!("{base} ({n})"));
        if fs::symlink_metadata(&p).is_err() {
            return p;
        }
    }
    dir.join(format!("{base} ({})", std::process::id()))
}

/// Creates the record folder (and its marker naming record `id`).
pub(crate) fn prepare_folder(folder: &Path, id: u64) -> std::io::Result<()> {
    fs::create_dir_all(folder)?;
    let marker = folder.join(MARKER);
    if marker_id(folder) != Some(id) {
        write_atomic(&marker, json!({ "id": id }).to_string().as_bytes())?;
    }
    Ok(())
}

/// The record id the marker of `folder` names (the marker must be a plain
/// file, not a symlink).
pub(crate) fn marker_id(folder: &Path) -> Option<u64> {
    let marker = folder.join(MARKER);
    let meta = fs::symlink_metadata(&marker).ok()?;
    if !meta.is_file() || meta.len() > 4096 {
        return None;
    }
    let v: Value = serde_json::from_str(&fs::read_to_string(marker).ok()?).ok()?;
    v.get("id")?.as_u64()
}

/// Names in `folder` (empty when unreadable).
pub(crate) fn names(folder: &Path) -> Vec<String> {
    fs::read_dir(folder)
        .map(|it| it.flatten().filter_map(|e| e.file_name().into_string().ok()).collect())
        .unwrap_or_default()
}

/// Removes everything in `folder` but its marker.
pub(crate) fn clear_folder(folder: &Path) {
    for n in names(folder) {
        if n == MARKER {
            continue;
        }
        let p = folder.join(&n);
        let _ = match fs::symlink_metadata(&p) {
            Ok(m) if m.is_dir() => fs::remove_dir_all(&p),
            Ok(_) => fs::remove_file(&p),
            Err(_) => continue,
        };
    }
}

/// Extension for a progressive download: the URL's, else the content
/// type's, else mp4.
pub(crate) fn file_ext(url_path: &str, mime: Option<&str>) -> &'static str {
    const KNOWN: [&str; 7] = ["mp4", "m4v", "webm", "mov", "mkv", "ts", "m2ts"];
    let ext = url_path.rsplit_once('.').map(|(_, e)| e.to_ascii_lowercase()).unwrap_or_default();
    if let Some(k) = KNOWN.iter().find(|k| **k == ext) {
        return k;
    }
    match mime.map(|m| m.split(';').next().unwrap_or("").trim().to_ascii_lowercase()).as_deref() {
        Some("video/webm") => "webm",
        Some("video/quicktime") => "mov",
        Some("video/x-matroska") => "mkv",
        Some("video/mp2t") => "ts",
        _ => "mp4",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rustflix-store-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn safe_names() {
        assert_eq!(safe_name("Show S1E2"), "Show S1E2");
        assert_eq!(safe_name("a/b\\c:d*e?f\"g<h>i|j%k#l"), "a-b-c-d-e-f-g-h-i-j-k-l");
        assert_eq!(safe_name("..hidden"), "hidden");
        assert_eq!(safe_name("  ...  "), "video");
        assert_eq!(safe_name(""), "video");
        assert_eq!(safe_name("x\ny\u{0}"), "x-y-");
        assert_eq!(safe_name("name."), "name");
        let long = "é".repeat(300);
        assert_eq!(safe_name(&long).chars().count(), 100);
    }

    #[test]
    fn unique_folders_and_markers() {
        let dir = temp("unique");
        let a = unique_folder(&dir, "Movie");
        assert_eq!(a, dir.join("Movie"));
        prepare_folder(&a, 3).unwrap();
        assert_eq!(marker_id(&a), Some(3));
        let b = unique_folder(&dir, "Movie");
        assert_eq!(b, dir.join("Movie (2)"));
        fs::write(dir.join("Movie (2)"), b"a file").unwrap();
        assert_eq!(unique_folder(&dir, "Movie"), dir.join("Movie (3)"));
        fs::write(a.join("x.ts"), b"1").unwrap();
        clear_folder(&a);
        assert_eq!(names(&a), vec![MARKER.to_owned()]);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn records_persist_atomically() {
        let dir = temp("persist");
        let path = dir.join("sub/rustflix-downloads.json");
        assert_eq!(load(&path), Saved::default());
        let rec = Record {
            id: 4,
            name: "Show S1E2".into(),
            status: "done".into(),
            kind: "hls".into(),
            folder: dir.join("Show S1E2"),
            file: Some("index.m3u8".into()),
            media_type: Some("tv".into()),
            media_id: Some(12),
            season: Some(1),
            episode: Some(2),
            created_at: 1.5e12,
            ..Default::default()
        };
        let saved = Saved { v: 1, next_id: 5, dir: dir.to_string_lossy().into(), configured: true, records: vec![rec.clone()] };
        save(&path, &saved).unwrap();
        assert_eq!(load(&path), saved);
        // No temp files left behind.
        assert_eq!(names(&dir.join("sub")), vec!["rustflix-downloads.json".to_owned()]);
        let j = rec.json();
        assert_eq!(j["type"], "tv");
        assert_eq!(j["file"], dir.join("Show S1E2/index.m3u8").to_string_lossy().as_ref());
        assert_eq!(j["waiting"], Value::Null);
        assert_eq!(j["done"], Value::Null);
        // Unfinished records have no file.
        let mut r2 = rec.clone();
        r2.status = "running".into();
        assert!(r2.json().get("file").is_none());
        // A corrupt store is set aside.
        fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path), Saved::default());
        assert!(dir.join("sub/rustflix-downloads.json.corrupt").exists());
        // Older/partial files decode with defaults.
        fs::write(&path, br#"{"nextId":9,"records":[{"id":2,"name":"x","status":"running"}]}"#).unwrap();
        let s = load(&path);
        assert_eq!(s.next_id, 9);
        assert_eq!(s.records[0].epoch, 0);
        fs::remove_dir_all(&dir).unwrap();
    }

    #[test]
    fn progressive_extensions() {
        assert_eq!(file_ext("/a/b.webm", None), "webm");
        assert_eq!(file_ext("/a/b", Some("video/quicktime; x=1")), "mov");
        assert_eq!(file_ext("/a/b.php", None), "mp4");
    }
}

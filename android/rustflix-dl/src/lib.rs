//! rustflix's downloader on Android: the desktop shell's `src/dl` (HLS +
//! progressive transfers with resume, link expiry, the localhost playback
//! server, the record store), compiled as is into `librustflix_dl.so`.
//!
//! - [`dl`] is `src/dl/mod.rs` itself (`#[path]`), untouched; the pieces of
//!   the desktop binary it reaches (`crate::cache`, `crate::files`) are
//!   given Android meanings here, and `nsh_engine` is a stand-in crate.
//! - [`bridge`] answers the app's `dl.*` calls as JSON in, JSON out — the
//!   same host API the desktop shell (`dl::register`) and the iPhone app
//!   (`Downloads.swift`) speak — and adds Android's Wi-Fi-only gate.
//! - [`stream`] is `src/stream/mod.rs` (the streaming proxy), likewise;
//!   [`streams`] answers `dl.stream.*` with it.
//! - `jni` (Android only) exposes both to `com.hexuria.rustflix.DlNative`.

#![allow(dead_code)]

pub mod bridge;
#[cfg(target_os = "android")]
mod jni_glue;
pub mod streams;

#[path = "../../../src/dl/mod.rs"]
pub(crate) mod dl;
/// The streaming proxy (`dl.stream.*`), as the desktop builds it.
#[path = "../../../src/stream/mod.rs"]
pub(crate) mod stream;

/// `crate::cache` of the desktop binary: only the size walk.
pub(crate) mod cache {
    use std::{fs, path::Path};

    /// Bytes of the files under `dir` (symlinks not followed); 0 when it
    /// is missing or unreadable.
    pub(crate) fn dir_size(dir: &Path) -> u64 {
        let Ok(entries) = fs::read_dir(dir) else {
            return 0;
        };
        entries
            .flatten()
            .map(|entry| match entry.path().symlink_metadata() {
                Ok(meta) if meta.is_dir() => dir_size(&entry.path()),
                Ok(meta) => meta.len(),
                Err(_) => 0,
            })
            .sum()
    }
}

/// `crate::files` of the desktop binary, for Android: free space by
/// statvfs, and "trash" is a delete (there is no Trash; the app's own
/// external files directory is the only place downloads live).
pub(crate) mod files {
    use std::{
        fs,
        path::{Component, Path, PathBuf},
    };

    /// `path` as an entry of folder `dir` (canonical `dir` + the rest): both
    /// absolute, no `.`/`..`, every folder between them a real folder, the
    /// entry present (not followed).
    pub(crate) fn inside(dir: &Path, path: &Path) -> Option<PathBuf> {
        if !dir.is_absolute() || !path.is_absolute() {
            return None;
        }
        if path
            .components()
            .chain(dir.components())
            .any(|c| matches!(c, Component::ParentDir | Component::CurDir))
        {
            return None;
        }
        let canon = fs::canonicalize(dir).ok()?;
        if !canon.is_dir() {
            return None;
        }
        let rest = path.strip_prefix(dir).or_else(|_| path.strip_prefix(&canon)).ok()?;
        let parts: Vec<_> = rest.components().collect();
        let (last, folders) = parts.split_last()?;
        let mut cur = canon;
        for part in folders {
            let Component::Normal(name) = part else { return None };
            cur.push(name);
            let meta = fs::symlink_metadata(&cur).ok()?;
            if !meta.is_dir() || meta.file_type().is_symlink() {
                return None;
            }
        }
        let Component::Normal(name) = last else { return None };
        cur.push(name);
        fs::symlink_metadata(&cur).ok()?;
        Some(cur)
    }

    /// The nearest existing folder at or above `path`.
    pub(crate) fn existing_parent(path: &Path) -> Option<PathBuf> {
        let mut cur = Some(path);
        while let Some(p) = cur {
            if p.is_dir() {
                return Some(p.to_path_buf());
            }
            cur = p.parent();
        }
        None
    }

    /// Bytes free on the volume holding `path` (or its nearest parent).
    pub(crate) fn free_space(path: &Path) -> Option<u64> {
        use std::{ffi::CString, os::unix::ffi::OsStrExt};
        let dir = existing_parent(path)?;
        let c = CString::new(dir.as_os_str().as_bytes()).ok()?;
        let mut st = std::mem::MaybeUninit::<libc::statvfs>::zeroed();
        // SAFETY: `c` is a NUL-terminated path; `st` is only read on success.
        let rc = unsafe { libc::statvfs(c.as_ptr(), st.as_mut_ptr()) };
        if rc != 0 {
            return None;
        }
        // SAFETY: statvfs returned 0.
        let st = unsafe { st.assume_init() };
        #[allow(clippy::unnecessary_cast)]
        Some((st.f_bavail as u64).saturating_mul(st.f_frsize as u64))
    }

    /// `folder` as record `id`'s folder: a direct child of `dir`, a real
    /// folder, holding the record marker (naming `id` when given).
    pub(crate) fn record_folder(dir: &Path, folder: &Path, id: Option<u64>) -> Option<PathBuf> {
        let p = inside(dir, folder)?;
        let canon_dir = fs::canonicalize(dir).ok()?;
        if p.parent()? != canon_dir {
            return None;
        }
        let meta = fs::symlink_metadata(&p).ok()?;
        if !meta.is_dir() || meta.file_type().is_symlink() {
            return None;
        }
        let named = crate::dl::store::marker_id(&p)?;
        if id.is_some_and(|id| id != named) {
            return None;
        }
        Some(p)
    }

    /// Deletes record `id`'s folder (only a checked record folder).
    pub(crate) fn trash_record_folder(dir: &Path, folder: &Path, id: Option<u64>) -> bool {
        match record_folder(dir, folder, id) {
            Some(p) => {
                let ok = fs::remove_dir_all(&p).is_ok();
                if !ok {
                    log::warn!("dl: could not delete {}", p.display());
                }
                ok
            }
            None => false,
        }
    }

    /// No file manager to show a file in.
    pub(crate) fn reveal_path(_path: &Path) -> bool {
        false
    }
}

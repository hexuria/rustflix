//! Changing the download folder: validating the new one and moving record
//! folders there (a rename on the same volume, copy-verify-delete across
//! volumes, never over an existing entry).

use std::{
    fs, io,
    path::{Component, Path, PathBuf},
};

/// System locations a download folder may never be in (or be).
pub(crate) const SYSTEM: [&str; 16] = [
    "/System", "/usr", "/bin", "/sbin", "/etc", "/dev", "/cores", "/Library", "/Applications", "/opt", "/var", "/tmp",
    "/private", "/Network", "/Volumes/Recovery", "/nix",
];

/// `path` made absolute against nothing: the nearest existing parent
/// canonicalised, the rest appended (so `/var` → `/private/var` and
/// symlinked parents are seen through).
fn real(path: &Path) -> Option<PathBuf> {
    let mut rest = Vec::new();
    let mut cur = path;
    loop {
        if let Ok(c) = fs::canonicalize(cur) {
            let mut out = c;
            for part in rest.iter().rev() {
                out.push(part);
            }
            return Some(out);
        }
        rest.push(cur.file_name()?.to_owned());
        cur = cur.parent()?;
    }
}

/// Checks a new download folder and creates it. `forbidden`: folders it
/// may not be inside ([`SYSTEM`], the app bundle, `~/Library`); `records`:
/// the current record folders (it may not be inside one).
pub(crate) fn validate(path: &str, current: &Path, forbidden: &[PathBuf], records: &[PathBuf]) -> Result<PathBuf, String> {
    let p = Path::new(path.trim());
    if path.trim().is_empty() || !p.is_absolute() {
        return Err("Choose a full folder path (starting with / or ~).".into());
    }
    if p.components().any(|c| matches!(c, Component::ParentDir | Component::CurDir)) {
        return Err("The folder path may not contain \".\" or \"..\".".into());
    }
    if p.parent().is_none() {
        return Err("The top of the disk can't be the download folder.".into());
    }
    let r = real(p).ok_or("That folder can't be used.")?;
    for f in forbidden {
        let f = real(f).unwrap_or_else(|| f.clone());
        if r.starts_with(&f) {
            return Err(format!("{} is a system or app folder — choose another one.", r.display()));
        }
    }
    let cur = real(current).unwrap_or_else(|| current.to_path_buf());
    if r == cur {
        return Err("That's already the download folder.".into());
    }
    for rec in records {
        let rr = real(rec).unwrap_or_else(|| rec.clone());
        if r.starts_with(&rr) {
            return Err("The new folder can't be inside one of the downloads.".into());
        }
    }
    if let Ok(meta) = fs::symlink_metadata(&r)
        && !meta.is_dir()
    {
        return Err(format!("{} is a file, not a folder.", r.display()));
    }
    fs::create_dir_all(&r).map_err(|e| format!("Couldn't create {}: {e}", r.display()))?;
    let probe = r.join(format!(".rustflix-write-test-{}", std::process::id()));
    fs::write(&probe, b"x").map_err(|e| format!("Can't write to {}: {e}", r.display()))?;
    let _ = fs::remove_file(&probe);
    Ok(r)
}

/// Bytes and count of the files under `dir` (symlinks not followed).
fn tree(dir: &Path) -> io::Result<Vec<(PathBuf, u64)>> {
    let mut out = Vec::new();
    for e in fs::read_dir(dir)? {
        let e = e?;
        let p = e.path();
        let meta = fs::symlink_metadata(&p)?;
        if meta.is_dir() {
            for (sub, n) in tree(&p)? {
                out.push((Path::new(&e.file_name()).join(sub), n));
            }
        } else if meta.is_file() {
            out.push((PathBuf::from(e.file_name()), meta.len()));
        }
    }
    out.sort();
    Ok(out)
}

fn copy_tree(src: &Path, dst: &Path) -> io::Result<()> {
    fs::create_dir(dst)?;
    for e in fs::read_dir(src)? {
        let e = e?;
        let p = e.path();
        let meta = fs::symlink_metadata(&p)?;
        let to = dst.join(e.file_name());
        if meta.is_dir() {
            copy_tree(&p, &to)?;
        } else if meta.is_file() {
            fs::copy(&p, &to)?;
        }
        // Symlinks are never followed or copied.
    }
    Ok(())
}

fn is_cross_device(e: &io::Error) -> bool {
    #[cfg(unix)]
    if e.raw_os_error() == Some(libc::EXDEV) {
        return true;
    }
    e.kind() == io::ErrorKind::CrossesDevices
}

/// Moves folder `src` into `dest_dir` (keeping its name). Never replaces an
/// existing entry; on failure `src` is where it was and nothing half-copied
/// stays behind. `force_copy` takes the cross-volume path (tests).
pub(crate) fn move_into(src: &Path, dest_dir: &Path, force_copy: bool) -> Result<PathBuf, String> {
    let name = src.file_name().ok_or("bad folder")?;
    let dest = dest_dir.join(name);
    if fs::symlink_metadata(&dest).is_ok() {
        return Err(format!("a different \"{}\" already exists there", name.to_string_lossy()));
    }
    if !force_copy {
        match fs::rename(src, &dest) {
            Ok(()) => return Ok(dest),
            Err(e) if is_cross_device(&e) => {}
            Err(e) => return Err(e.to_string()),
        }
    }
    let tmp = dest_dir.join(format!(".{}.moving-{}", name.to_string_lossy(), std::process::id()));
    let _ = fs::remove_dir_all(&tmp);
    let copied = copy_tree(src, &tmp).and_then(|()| {
        let (a, b) = (tree(src)?, tree(&tmp)?);
        if a != b {
            return Err(io::Error::other("the copy does not match"));
        }
        if fs::symlink_metadata(&dest).is_ok() {
            return Err(io::Error::other("the destination appeared meanwhile"));
        }
        fs::rename(&tmp, &dest)
    });
    if let Err(e) = copied {
        let _ = fs::remove_dir_all(&tmp);
        return Err(e.to_string());
    }
    if let Err(e) = fs::remove_dir_all(src) {
        log::warn!("dl: moved {} but could not remove the old copy: {e}", src.display());
    }
    Ok(dest)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("rustflix-folder-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::canonicalize(&dir).unwrap()
    }

    #[test]
    fn validation() {
        let root = temp("validate");
        let cur = root.join("cur");
        fs::create_dir_all(cur.join("Movie")).unwrap();
        let forbidden: Vec<PathBuf> = SYSTEM.iter().map(PathBuf::from).collect();
        let none: Vec<PathBuf> = vec![];
        let recs = vec![cur.join("Movie")];
        assert!(validate("relative/path", &cur, &none, &recs).is_err());
        assert!(validate("", &cur, &none, &recs).is_err());
        assert!(validate("/", &cur, &none, &recs).is_err());
        assert!(validate(&format!("{}/a/../b", root.display()), &cur, &none, &recs).is_err());
        assert!(validate("/System/Library/x", &cur, &forbidden, &recs).unwrap_err().contains("system"));
        assert!(validate("/usr/local/dl", &cur, &forbidden, &recs).is_err());
        // The temp dir is under /private/var: forbidden with the system list.
        assert!(validate(&root.join("new").to_string_lossy(), &cur, &forbidden, &recs).is_err());
        assert!(validate(&cur.to_string_lossy(), &cur, &none, &recs).unwrap_err().contains("already"));
        assert!(validate(&cur.join("Movie/x").to_string_lossy(), &cur, &none, &recs).is_err());
        fs::write(root.join("file"), b"x").unwrap();
        assert!(validate(&root.join("file").to_string_lossy(), &cur, &none, &recs).is_err());
        let bundle = root.join("rustflix.app");
        assert!(validate(&bundle.join("Contents/x").to_string_lossy(), &cur, std::slice::from_ref(&bundle), &recs).is_err());
        let ok = validate(&root.join("new/deeper").to_string_lossy(), &cur, &none, &recs).unwrap();
        assert!(ok.is_dir());
        assert!(fs::read_dir(&ok).unwrap().next().is_none(), "the write probe is removed");
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn moves_by_rename_or_copy_never_over_another() {
        let root = temp("move");
        let (a, b) = (root.join("a"), root.join("b"));
        fs::create_dir_all(a.join("Movie")).unwrap();
        fs::write(a.join("Movie/Movie.mp4"), vec![1u8; 5000]).unwrap();
        fs::write(a.join("Movie/.rustflix-download"), b"{\"id\":1}").unwrap();
        fs::create_dir_all(a.join("Show/sub")).unwrap();
        fs::write(a.join("Show/sub/f0.ts"), b"ts").unwrap();
        fs::create_dir_all(&b).unwrap();
        // Same volume: a rename.
        let moved = move_into(&a.join("Movie"), &b, false).unwrap();
        assert_eq!(moved, b.join("Movie"));
        assert!(!a.join("Movie").exists());
        assert_eq!(fs::read(b.join("Movie/Movie.mp4")).unwrap().len(), 5000);
        // The cross-volume path: copy, verify, delete.
        let moved = move_into(&a.join("Show"), &b, true).unwrap();
        assert_eq!(fs::read(moved.join("sub/f0.ts")).unwrap(), b"ts");
        assert!(!a.join("Show").exists());
        assert!(!fs::read_dir(&b).unwrap().flatten().any(|e| e.file_name().to_string_lossy().contains("moving")));
        // An existing folder of that name: refused, the source stays.
        fs::create_dir_all(a.join("Movie")).unwrap();
        fs::write(a.join("Movie/other.mp4"), b"o").unwrap();
        assert!(move_into(&a.join("Movie"), &b, false).is_err());
        assert!(move_into(&a.join("Movie"), &b, true).is_err());
        assert!(a.join("Movie/other.mp4").exists());
        assert_eq!(fs::read(b.join("Movie/Movie.mp4")).unwrap().len(), 5000);
        fs::remove_dir_all(&root).unwrap();
    }
}

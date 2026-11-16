//! Windows shell calls behind `fs.*` and the downloader: free space, the
//! Recycle Bin and Explorer.
//!
//! The shell's COM objects want a single-threaded apartment, and the
//! callers (host-call threads, the downloader) are plain threads, so each
//! call runs on a short-lived thread of its own that initialises COM as STA
//! ([`on_sta`]).
//!
//! Paths: `files::inside` hands over canonical paths, which on Windows are
//! verbatim (`\\?\C:\…`); the shell's parser does not take that form, so
//! [`plain`] turns them back into ordinary ones first.

use std::{
    path::{Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicBool, Ordering},
    },
};

use windows::Win32::{
    Foundation::E_ABORT,
    Storage::FileSystem::GetDiskFreeSpaceExW,
    System::Com::{CLSCTX_ALL, COINIT_APARTMENTTHREADED, COINIT_DISABLE_OLE1DDE, CoCreateInstance, CoInitializeEx, CoUninitialize},
    UI::Shell::{
        FILEOPERATION_FLAGS, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FOFX_EARLYFAILURE,
        FOFX_RECYCLEONDELETE, FileOperation, IFileOperation, IFileOperationProgressSink,
        IFileOperationProgressSink_Impl, ILCreateFromPathW, ILFree, IShellItem, SHCreateItemFromParsingName,
        SHOpenFolderAndSelectItems, TSF_DELETE_RECYCLE_IF_POSSIBLE,
    },
};
use windows_core::{HRESULT, HSTRING, PCWSTR, Ref, implement};

/// A canonical (verbatim) path as the shell and the file APIs parse it:
/// `\\?\C:\a` → `C:\a`, `\\?\UNC\host\share` → `\\host\share`.
pub(crate) fn plain(path: &Path) -> PathBuf {
    let Some(s) = path.to_str() else { return path.to_path_buf() };
    if let Some(rest) = s.strip_prefix(r"\\?\UNC\") {
        PathBuf::from(format!(r"\\{rest}"))
    } else if let Some(rest) = s.strip_prefix(r"\\?\") {
        PathBuf::from(rest)
    } else {
        path.to_path_buf()
    }
}

fn wide(path: &Path) -> HSTRING {
    HSTRING::from(plain(path).as_os_str())
}

/// Bytes free for this user on the volume holding folder `dir`
/// (`GetDiskFreeSpaceExW`, quotas included).
pub(crate) fn free_space(dir: &Path) -> Option<u64> {
    let mut free = 0u64;
    // SAFETY: a NUL-terminated wide path; `free` outlives the call and is
    // read only on success.
    unsafe { GetDiskFreeSpaceExW(&wide(dir), Some(&mut free), None, None) }.ok()?;
    Some(free)
}

/// Runs `f` on a new thread in a single-threaded COM apartment and
/// returns its answer (false if the thread could not run).
fn on_sta(f: impl FnOnce() -> bool + Send + 'static) -> bool {
    std::thread::Builder::new()
        .name("rustflix-shell".into())
        .spawn(move || {
            // SAFETY: balanced by CoUninitialize on this thread.
            let com = unsafe { CoInitializeEx(None, COINIT_APARTMENTTHREADED | COINIT_DISABLE_OLE1DDE) }.is_ok();
            let out = f();
            if com {
                // SAFETY: this thread's successful CoInitializeEx.
                unsafe { CoUninitialize() };
            }
            out
        })
        .ok()
        .and_then(|t| t.join().ok())
        .unwrap_or(false)
}

/// Watches a delete: refuses any item the shell would destroy instead of
/// recycling, and records whether the item reached the Recycle Bin.
#[implement(IFileOperationProgressSink)]
struct RecycleOnly {
    recycled: Arc<AtomicBool>,
    refused: Arc<AtomicBool>,
}

impl IFileOperationProgressSink_Impl for RecycleOnly_Impl {
    fn StartOperations(&self) -> windows_core::Result<()> {
        Ok(())
    }
    fn FinishOperations(&self, _hr: HRESULT) -> windows_core::Result<()> {
        Ok(())
    }
    fn PreRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostRenameItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> windows_core::Result<()> {
        Ok(())
    }
    fn PreMoveItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostMoveItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> windows_core::Result<()> {
        Ok(())
    }
    fn PreCopyItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostCopyItem(&self, _: u32, _: Ref<IShellItem>, _: Ref<IShellItem>, _: &PCWSTR, _: HRESULT, _: Ref<IShellItem>) -> windows_core::Result<()> {
        Ok(())
    }
    fn PreDeleteItem(&self, flags: u32, _item: Ref<IShellItem>) -> windows_core::Result<()> {
        // The shell sets TSF_DELETE_RECYCLE_IF_POSSIBLE on an item it will
        // recycle; without it the item would be destroyed (no Recycle Bin on
        // that volume, too large for it, a network share). Like the Linux
        // Trash, never fall back to deleting: refuse the item.
        if flags & TSF_DELETE_RECYCLE_IF_POSSIBLE.0 as u32 == 0 {
            self.refused.store(true, Ordering::SeqCst);
            return Err(E_ABORT.into());
        }
        Ok(())
    }
    fn PostDeleteItem(&self, _: u32, _: Ref<IShellItem>, hr: HRESULT, newly_created: Ref<IShellItem>) -> windows_core::Result<()> {
        // A recycled item comes back as its new place in the Recycle Bin.
        if hr.is_ok() && newly_created.is_some() {
            self.recycled.store(true, Ordering::SeqCst);
        }
        Ok(())
    }
    fn PreNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR) -> windows_core::Result<()> {
        Ok(())
    }
    fn PostNewItem(&self, _: u32, _: Ref<IShellItem>, _: &PCWSTR, _: &PCWSTR, _: u32, _: HRESULT, _: Ref<IShellItem>) -> windows_core::Result<()> {
        Ok(())
    }
    fn UpdateProgress(&self, _: u32, _: u32) -> windows_core::Result<()> {
        Ok(())
    }
    fn ResetTimer(&self) -> windows_core::Result<()> {
        Ok(())
    }
    fn PauseTimer(&self) -> windows_core::Result<()> {
        Ok(())
    }
    fn ResumeTimer(&self) -> windows_core::Result<()> {
        Ok(())
    }
}

/// Moves `path` (a file, or a folder with what is in it) to the Recycle
/// Bin, as Explorer's Delete does, with no UI. True only when it got there:
/// where the shell would delete it for good instead, nothing happens and
/// the answer is false.
pub(crate) fn trash(path: &Path) -> bool {
    let path = wide(path);
    on_sta(move || {
        let recycled = Arc::new(AtomicBool::new(false));
        let refused = Arc::new(AtomicBool::new(false));
        let sink: IFileOperationProgressSink =
            RecycleOnly { recycled: recycled.clone(), refused: refused.clone() }.into();
        // SAFETY: COM calls on this STA thread with live arguments.
        let done = unsafe {
            (|| -> windows_core::Result<bool> {
                let item: IShellItem = SHCreateItemFromParsingName(&path, None)?;
                let op: IFileOperation = CoCreateInstance(&FileOperation, None, CLSCTX_ALL)?;
                let flags = FOF_ALLOWUNDO.0 | FOFX_RECYCLEONDELETE.0 | FOF_NOCONFIRMATION.0 | FOF_SILENT.0 | FOF_NOERRORUI.0 | FOFX_EARLYFAILURE.0;
                op.SetOperationFlags(FILEOPERATION_FLAGS(flags))?;
                op.DeleteItem(&item, &sink)?;
                let performed = op.PerformOperations();
                let aborted = op.GetAnyOperationsAborted().map(|b| b.as_bool()).unwrap_or(true);
                Ok(performed.is_ok() && !aborted)
            })()
        };
        if refused.load(Ordering::SeqCst) {
            log::warn!("fs.trash: {path} would be deleted for good, not recycled: left in place");
        }
        matches!(done, Ok(true)) && recycled.load(Ordering::SeqCst)
    })
}

/// Opens Explorer on the folder holding `path` with `path` selected.
pub(crate) fn reveal(path: &Path) -> bool {
    let path = wide(path);
    on_sta(move || {
        // SAFETY: the item list is created from a NUL-terminated path,
        // used, and freed once.
        unsafe {
            let pidl = ILCreateFromPathW(&path);
            if pidl.is_null() {
                return false;
            }
            let ok = SHOpenFolderAndSelectItems(pidl, None, 0).is_ok();
            ILFree(Some(pidl));
            ok
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plain_paths() {
        assert_eq!(plain(Path::new(r"\\?\C:\a\b")), PathBuf::from(r"C:\a\b"));
        assert_eq!(plain(Path::new(r"\\?\UNC\host\share\x")), PathBuf::from(r"\\host\share\x"));
        assert_eq!(plain(Path::new(r"C:\a")), PathBuf::from(r"C:\a"));
    }

    #[test]
    fn free_space_of_temp() {
        assert!(free_space(&std::env::temp_dir()).is_some_and(|n| n > 0));
    }

    /// Moves a scratch file to the user's Recycle Bin (run by hand).
    #[test]
    #[ignore = "puts a file in this user's Recycle Bin"]
    fn trash_recycles() {
        let dir = std::env::temp_dir().join(format!("rustflix-trash-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("recycle me.mp4");
        std::fs::write(&f, b"x").unwrap();
        assert!(trash(&std::fs::canonicalize(&f).unwrap()));
        assert!(!f.exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// A network share has no Recycle Bin: the file must stay.
    #[test]
    #[ignore = "needs the C$ administrative share"]
    fn trash_refuses_where_it_would_delete() {
        let dir = std::env::temp_dir().join(format!("rustflix-nuke-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("keep.mp4"), b"x").unwrap();
        let local = dir.join("keep.mp4").to_string_lossy().into_owned();
        let unc = format!(r"\\localhost\{}$\{}", &local[..1], &local[3..]);
        assert!(Path::new(&unc).exists(), "{unc}");
        assert!(!trash(Path::new(&unc)));
        assert!(dir.join("keep.mp4").exists());
        std::fs::remove_dir_all(&dir).unwrap();
    }
}

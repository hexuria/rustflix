//! The app window's caption on Windows.
//!
//! NSH marks its `windowDrag` views (the app's own title bar) as caption
//! (`HTCAPTION`, GPUI's `WindowControlArea::Drag`), so that Windows moves the
//! window — with Snap — and maximizes/restores it on a double click. But
//! gpui-fast first hands the press to GPUI as a mouse-down, and NSH's drag
//! area handles it (`cx.stop_propagation`, nsh-platform-gpui `chrome.rs`
//! `drag_area`), so gpui-fast reports the press handled and `DefWindowProc`
//! never sees it: no move loop, no Snap, no double-click. NSH's fallback,
//! `Window::start_window_move`, does nothing on Windows, and its double
//! click calls `zoom_window`, which only maximizes.
//!
//! Each of GPUI's windows is subclassed (`SetWindowSubclass`) so that a left
//! press or double click on the caption goes to `DefWindowProc` directly,
//! as for any captioned window. Everything else reaches GPUI unchanged. An
//! out-of-context WinEvent hook on the main thread (`EVENT_OBJECT_CREATE`)
//! names each window as it is made: nothing runs while no window is.

use windows::Win32::{
    Foundation::{HWND, LPARAM, LRESULT, WPARAM},
    System::Threading::{GetCurrentProcessId, GetCurrentThreadId},
    UI::{
        Accessibility::{HWINEVENTHOOK, SetWinEventHook},
        Shell::{DefSubclassProc, RemoveWindowSubclass, SetWindowSubclass},
        WindowsAndMessaging::{
            CHILDID_SELF, DefWindowProcW, EVENT_OBJECT_CREATE, EnumThreadWindows, GetClassNameW,
            HTCAPTION, OBJID_WINDOW, WINEVENT_OUTOFCONTEXT, WM_NCDESTROY, WM_NCLBUTTONDBLCLK,
            WM_NCLBUTTONDOWN,
        },
    },
};

/// The subclass's id.
const SUBCLASS: usize = 0x5246_4350; // "RFCP"

unsafe extern "system" fn caption_proc(
    hwnd: HWND,
    msg: u32,
    wparam: WPARAM,
    lparam: LPARAM,
    _id: usize,
    _data: usize,
) -> LRESULT {
    // SAFETY: the window's own messages, on its thread.
    unsafe {
        match msg {
            WM_NCLBUTTONDOWN | WM_NCLBUTTONDBLCLK if wparam.0 as u32 == HTCAPTION => {
                return DefWindowProcW(hwnd, msg, wparam, lparam);
            }
            WM_NCDESTROY => {
                let _ = RemoveWindowSubclass(hwnd, Some(caption_proc), SUBCLASS);
            }
            _ => {}
        }
        DefSubclassProc(hwnd, msg, wparam, lparam)
    }
}

/// Subclasses `hwnd` when it is one of GPUI's windows (setting it again
/// only updates it).
fn adopt(hwnd: HWND) {
    let mut name = [0u16; 64];
    // SAFETY: a window of this thread; a buffer of ours.
    let n = unsafe { GetClassNameW(hwnd, &mut name) } as usize;
    if String::from_utf16_lossy(&name[..n]) == "GpuiFast::Window" {
        // SAFETY: a window of this thread and a procedure that lives as long
        // as the process.
        let _ = unsafe { SetWindowSubclass(hwnd, Some(caption_proc), SUBCLASS, 0) };
    }
}

unsafe extern "system" fn each(hwnd: HWND, _: LPARAM) -> windows_core::BOOL {
    adopt(hwnd);
    true.into()
}

/// A window of this thread was made (delivered through the thread's
/// message loop once its creation returned).
unsafe extern "system" fn created(_: HWINEVENTHOOK, event: u32, hwnd: HWND, object: i32, child: i32, _: u32, _: u32) {
    if event == EVENT_OBJECT_CREATE && object == OBJID_WINDOW.0 && child == CHILDID_SELF as i32 && !hwnd.is_invalid() {
        adopt(hwnd);
    }
}

/// Starts watching for GPUI's windows (main thread, before GPUI makes any).
pub(crate) fn install() {
    // SAFETY: an out-of-context hook for this thread's own windows, with a
    // static procedure; the main thread's message loop (GPUI's) delivers it.
    let hook = unsafe {
        SetWinEventHook(
            EVENT_OBJECT_CREATE,
            EVENT_OBJECT_CREATE,
            None,
            Some(created),
            GetCurrentProcessId(),
            GetCurrentThreadId(),
            WINEVENT_OUTOFCONTEXT,
        )
    };
    if hook.is_invalid() {
        log::warn!("window: no window hook; the title bar will not move the window");
    }
    // Any window made before (none, as called).
    // SAFETY: enumerates this (the main) thread's windows.
    let _ = unsafe { EnumThreadWindows(GetCurrentThreadId(), Some(each), LPARAM(0)) };
}
